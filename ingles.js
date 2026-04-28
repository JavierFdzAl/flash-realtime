import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import twilio from 'twilio';
import { google as googleapis } from 'googleapis';
import pkg from 'wavefile';
const { WaveFile } = pkg;

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = 'models/gemini-3.1-flash-live-preview',
  PORT = 8080,

  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,

  // Host público (https://tu-dominio) para callbacks
  PUBLIC_HOST = 'https://doobot-realtime-boston-712406184291.europe-west1.run.app',

  // Google Sheets para registro de llamadas
  GOOGLE_SHEETS_ID = '155ZeDhoMJvrVLERW9tQxHcBi7Y719m3wV4CLoNVQ_8U', // si lo dejas vacío, se creará uno nuevo
  GOOGLE_SHEETS_TITLE = 'Registro llamadas Fisio Badalona',
  GOOGLE_DRIVE_FOLDER_ID = '', // opcional, carpeta de Drive
} = process.env;

if (!GEMINI_API_KEY) {
  console.error('❌ Falta GEMINI_API_KEY en .env');
  process.exit(1);
}

function makeAbsUrl(pathname = '/') {
  const host = (PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `https://${host}${p}`;
}

/** ===== Util: sleep ===== */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ===== Audio Transcoding Helpers para Gemini <-> Twilio ===== */
function decodeTwilioToGemini(base64Payload) {
  try {
    const twilioMuLawBuffer = Buffer.from(base64Payload, 'base64');
    const muLawArray = new Uint8Array(twilioMuLawBuffer.buffer, twilioMuLawBuffer.byteOffset, twilioMuLawBuffer.byteLength);
    const wav = new WaveFile();
    wav.fromScratch(1, 8000, '8m', muLawArray);
    wav.fromMuLaw(); // Linear PCM 16-bit
    wav.toSampleRate(16000); // 16kHz
    wav.toBitDepth('16'); // Asegurarnos formato
    return Buffer.from(wav.data.samples.buffer).toString('base64');
  } catch (err) {
    console.error('Error in audo decode:', err);
    return null;
  }
}

function encodeGeminiToTwilio(base64PcmData) {
  try {
    const pcmBuffer = Buffer.from(base64PcmData, 'base64');
    const int16Array = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);
    const wav = new WaveFile();
    wav.fromScratch(1, 24000, '16', int16Array); // Gemini emite PCM 24kHz
    wav.toSampleRate(8000);
    wav.toMuLaw();
    return Buffer.from(wav.data.samples).toString('base64');
  } catch (err) {
    console.error('Error in audio encode:', err);
    return null;
  }
}

/** ===== Twilio REST (para colgar y grabar) ===== */
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

/** ===== Maps ===== */
const callInfo = new Map();
const requestedHangupFor = new Set();
const activeRecordingSid = new Map();

/** ===== Google APIs (registro de llamadas + solicitudes) ===== */
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

let callLogSheetId = GOOGLE_SHEETS_ID;
let clientsPromise = null;
let callLogHeaderWritten = false;
let requestsHeaderWritten = false;

async function getGoogleClients() {
  if (!clientsPromise) {
    clientsPromise = (async () => {
      const auth = await googleapis.auth.getClient({ scopes: SCOPES });
      const sheets = googleapis.sheets({ version: 'v4', auth });
      const drive = googleapis.drive({ version: 'v3', auth });
      return { auth, sheets, drive };
    })();
  }
  return clientsPromise;
}

async function ensureCallLogSheet() {
  const { drive } = await getGoogleClients();
  if (!callLogSheetId) {
    const fileMetadata = {
      name: GOOGLE_SHEETS_TITLE,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      ...(GOOGLE_DRIVE_FOLDER_ID ? { parents: [GOOGLE_DRIVE_FOLDER_ID] } : {}),
    };
    const createRes = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id, webViewLink',
    });
    callLogSheetId = createRes.data.id || '';
    const link = createRes.data.webViewLink || `https://docs.google.com/spreadsheets/d/${callLogSheetId}/edit`;
    console.log('🆕 Creado Spreadsheet para registro de llamadas:', link);
  }
}

async function appendCallLog({ callSid, from, to, startIso, endIso, durationSeconds }) {
  try {
    await ensureCallLogSheet();
    const { sheets } = await getGoogleClients();
    await sheets.spreadsheets.values.append({
      spreadsheetId: callLogSheetId,
      range: 'A:F',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[callSid || '', from || '', to || '', startIso || '', endIso || '', durationSeconds != null ? durationSeconds : '']],
      },
    });
    console.log('📄 Registro de llamada escrito en Sheets:', { callSid, durationSeconds });
  } catch (e) {
    console.error('🛑 Error al escribir registro de llamada en Google Sheets:', e?.errors || e?.message || e);
  }
}

async function ensureRequestsSheet() {
  const { sheets } = await getGoogleClients();
  if (requestsHeaderWritten) return;
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: callLogSheetId, range: 'Solicitudes!A1' });
  } catch (e) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: callLogSheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Solicitudes' } } }] },
      });
      console.log('🆕 Pestaña "Solicitudes" creada.');
    } catch (e2) { }
  }
  requestsHeaderWritten = true;
}

async function appendRequest({ phone, type }) {
  try {
    await ensureRequestsSheet();
    const { sheets } = await getGoogleClients();
    const ts = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: callLogSheetId,
      range: 'Solicitudes!A:C',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[phone || '', type || '', ts]] },
    });
    console.log('📋 Solicitud registrada en hoja:', { phone, type });
  } catch (e) {
    console.error('🛑 Error al escribir solicitud:', e?.errors || e?.message || e);
  }
}

async function startRecording(callSid) {
  if (!twilioClient) return { ok: false, error: 'no_twilio_credentials' };
  if (!callSid) return { ok: false, error: 'no_call_sid' };
  try {
    const rec = await twilioClient.calls(callSid).recordings.create({
      recordingTrack: 'both',
      recordingStatusCallback: makeAbsUrl('/recording-status'),
      recordingStatusCallbackEvent: ['in-progress', 'completed', 'absent'],
    });
    activeRecordingSid.set(callSid, rec.sid);
    console.log('🎙️ Grabación iniciada:', { recordingSid: rec.sid, callSid });
    return { ok: true, sid: rec.sid };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function hangUpCall(callSid, reason = 'fin_de_conversacion') {
  if (!twilioClient) return { ok: false, error: 'no_twilio_credentials' };
  if (!callSid) return { ok: false, error: 'no_call_sid' };
  if (requestedHangupFor.has(callSid)) return { ok: true, note: 'already_hanging' };
  try {
    console.log(`☎️ Ejecutando hangUpCall(callSid=${callSid}, reason=${reason})`);
    requestedHangupFor.add(callSid);
    await sleep(3000);
    await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`📞✅ Llamada colgada motivo=${reason}`);
    return { ok: true, callSid, reason };
  } catch (e) {
    requestedHangupFor.delete(callSid);
    return { ok: false, error: e?.message || String(e) };
  }
}

/** ===== Express ===== */
const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('OK. POST /voice (TwiML), WS /media-stream'));

app.all('/voice', async (req, res) => {
  try {
    const hostHeader = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
    const baseHost = PUBLIC_HOST ? PUBLIC_HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '') : hostHeader;
    const wsUrl = `wss://${baseHost}/media-stream`;

    const callSid = req.body?.CallSid || req.query?.CallSid || null;
    const fromNumber = req.body?.From || req.query?.From || '';
    const toNumber = req.body?.To || req.query?.To || '';
    if (callSid) {
      callInfo.set(callSid, { from: fromNumber, to: toNumber });
      console.log(`👤 Llamante: ${fromNumber} → ${toNumber} (callSid=${callSid})`);
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wsUrl}" /></Connect></Response>`;
    res.set('Content-Type', 'text/xml').status(200).send(twiml);
  } catch (e) {
    res.status(500).send('<Response><Say>Error en la app</Say></Response>');
  }
});

app.post('/recording-status', async (req, res) => {
  res.status(200).send('ok');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

/** ===== Gemini Multimodal Live API ===== */
const instruccionesSistema = `You are an AI assistant for Boston Medical and you must strictly follow this voice support procedure.

Speak ALWAYS in English. Use a warm, kind, calm and professional tone. You must sound natural and close, not robotic.

The default language is English. If the user speaks Spanish or another language, you may understand them, but you must continue replying in English unless the user explicitly asks you to switch language.

Do not mix languages in the same response. All appointment confirmations, requests for information, summaries, and tool-related responses must be spoken in English.

Barge-in: after the greeting, if the customer speaks, stop talking and give them the turn, even if you are saying a predefined sentence.

If the message does not make sense, is noise, or cannot be understood, say that you could not hear clearly and ask the user to repeat closer to the phone.

If the patient wants to schedule a review appointment with their doctor, tell them that their appointment is due in two months, and that we will contact them a few weeks before to schedule it. Ask why they want to request this appointment. If it is because they are experiencing side effects, schedule the appointment. Ask for their preferred day and time. When they provide them, say: "One second while I check availability." Then tell them the first option is not available and ask for a different day and time. Say again that you are checking availability, and then accept the second option. Confirm the appointment at their usual clinic address: Paseo de la Castellana 101, Madrid.

When scheduling an appointment, you must have the day, month and time. If any of these details are missing, ask for them until the user provides them.

Never schedule an appointment without both day and time.

If the user wants to schedule a therapy appointment, tell them they have three attended appointments and one scheduled for Friday, November 7, and that they can request one more. When they provide a day and time, tell them: "One second while I check availability", validate it, and confirm that it has been scheduled.

If the user wants to schedule a shockwave appointment, tell them they have three attended appointments and two scheduled. The scheduled ones are Tuesday, November 4 and Wednesday, November 19.

If the patient asks about their medication shipment, tell them that the shipment was made yesterday, and that delivery is expected today or tomorrow. For precise tracking information, refer the patient to seur.com/miseur/mis-envios and tell them that their tracking number is 7854AR4534.

Only if the patient says the medication arrived damaged or broken, tell them to contact Boston Medical patient support and send us a WhatsApp photo of the damaged medication. Once we validate the damage, we will urgently send the medication again.

If the patient is worried about whether the medication will last for the whole treatment, reassure them that they are expected to have all the medication needed, always according to the doctor’s prescribed guidelines.

ONLY when the customer says they have side effects, medical concerns, pain, or something medically delicate, transfer the call after saying: "We are going to transfer you to a member of our team", using the tool 'transfer_call'.

Do not transfer calls unless strictly necessary.

Use short natural pauses.

There are three types of appointments during the treatment: shockwave sessions, psychosexual therapy, and review appointments with the doctor.

Medical review appointments: in these appointments, the doctor evaluates treatment progress, reviews results, adjusts medication or guidelines according to the response to treatment, and answers the patient’s questions.

Shockwave sessions: shockwave therapy is applied painlessly to the penis using a specialized device. Its goal is to improve blood circulation and promote tissue regeneration, helping recover erectile function naturally. Each session lasts a few minutes and does not require anesthesia or recovery time. There are five sessions throughout the treatment, spaced at least seven days apart, and ideally not more than ten days apart.

Psychosexual therapy: these sessions focus on the emotional and behavioral aspects related to erectile dysfunction or premature ejaculation. Through a personalized approach, the therapist works with the patient, and if appropriate with their partner, to reduce anxiety, improve communication, and recover sexual confidence. They last 30 minutes. There are five sessions throughout the treatment, spaced at least seven days apart.

There is no problem with having a psychosexual therapy appointment and a shockwave session in the same week. Tell the patient that they are two parallel treatment lines and do not interfere with each other.

Shockwave sessions usually have no side effects. In some rare cases, mild and temporary effects may appear, such as redness or local inflammation, discomfort or mild pain during or after the session, tingling or warmth, and very rarely, small bruises. If any of these or other symptoms appear, the patient should immediately contact Boston Medical patient support so we can assess the situation and refer them to the doctor if necessary. No special preparation is required before a shockwave appointment; for example, fasting or special dietary care is not necessary.

If the patient asks about the composition of the medication, tell them that this should be discussed with the doctor. If it is only curiosity, refer them to the next review appointment. If it is relevant or urgent, tell them you will leave a note for the doctor to call them.

If the patient asks whether the call is being recorded, answer that the call is recorded for quality purposes, according to Boston Medical’s terms of service, which can be consulted at boston.es.

If the user wants to give feedback, first ask them to rate our services from 0 to 5. If they give decimals, tell them the score must be a whole number: 0, 1, 2, 3, 4 or 5. If they give a number below 0 or above 5, tell them the rating must be between 0 and 5 and ask again.

Once they provide the rating, ask for more detail. If the rating is 2 or lower, tell them that we are concerned about their low rating and that understanding the reasons would be very useful for improving. If the rating is between 3 and 4, simply tell them it would be very helpful if they could leave a brief message about their experience. If the rating is higher than 4, thank them and say we are happy with the level of satisfaction we have been able to generate, and that it would be useful to know the specific aspects behind such a positive rating.

MEDICAL INSURANCE AND POLICY:
If the user asks how long is left before their insurance expires, or asks about the validity of their insurance, tell them that you need their policy number to check it. Once they explicitly provide their policy number, verbally say: "Let me check your details, just a second" and immediately after that use the tool 'validate_policy' to validate it in the system. After receiving the tool result, verbally inform the user about the expiration date or any other information returned by the system.
`;

function connectGeminiRealtime() {
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
  return new WebSocket(url);
}



function sendTwilioAudio(twilioWs, streamSid, base64Payload) {
  if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
  twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: base64Payload } }));
}

function sendTwilioMark(twilioWs, streamSid, name) {
  if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
  twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name } }));
}

const callTimes = new Map();
const callRequests = new Map();

wss.on('connection', (twilioWs, req) => {
  console.log('📞 Twilio WS conectado desde', req.socket.remoteAddress);
  const geminiWs = connectGeminiRealtime();

  let streamSid = null;
  let callSid = null;
  let geminiReady = false;

  const safeSendToGemini = (obj) => {
    if (geminiWs.readyState !== WebSocket.OPEN) return false;
    geminiWs.send(JSON.stringify(obj));
    return true;
  };

  geminiWs.on('open', () => {
    console.log('✅ Gemini Multimodal Live conectado');

    const availableVoices = ["Aoede", "Charon", "Kore", "Puck"];
    const randomVoice = availableVoices[Math.floor(Math.random() * availableVoices.length)];
    console.log(`🗣️ Voz seleccionada aleatoriamente: ${randomVoice}`);

    // 1. SETUP INICIAL
    const setupMsg = {
    setup: {
      model: GEMINI_MODEL,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Puck"
            }
          }
        },
        thinkingConfig: {
          thinkingLevel: "minimal"
        }
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          prefixPaddingMs: 120,
          silenceDurationMs: 130
        },
        turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS"
      },
      systemInstruction: {
        parts: [{ text: instruccionesSistema.trim() }]
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'hangup_call',
              description: 'Cuelga la llamada de forma segura al finalizar la conversación.',
              parameters: {
                type: 'OBJECT',
                properties: { reason: { type: 'STRING' } }
              }
            },
            {
              name: 'register_request',
              description: 'Registra si quieren cita o hablar con un humano.',
              parameters: {
                type: 'OBJECT',
                properties: { kind: { type: 'STRING' } },
                required: ["kind"]
              }
            },
            {
              name: 'validate_policy',
              description: 'Valida la fecha de caducidad y estado del seguro enviando el número de póliza al sistema.',
              parameters: {
                type: 'OBJECT',
                properties: { policy_number: { type: 'STRING' } },
                required: ["policy_number"]
              }
            }
          ]
        }
      ]
    }
  };
    safeSendToGemini(setupMsg);
  });

  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'start') {
        const s = msg.start || {};
        streamSid = s.streamSid;
        callSid = s.callSid || callSid || null;
        console.log('🔗 streamSid:', streamSid, 'callSid:', callSid);

        if (callSid && !callTimes.has(callSid)) callTimes.set(callSid, { startedAt: new Date() });
        if (callSid) startRecording(callSid).catch(() => { });
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        if (!geminiReady) return;
        const b64 = msg.media.payload;
        const decodedPcm = decodeTwilioToGemini(b64);
        if (decodedPcm) {
          safeSendToGemini({
            realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: decodedPcm } }
          });
        }
        return;
      }

      if (msg.event === 'stop') {
        console.log('⏹️ Twilio stop');
        if (callSid) {
          const now = new Date();
          const info = callTimes.get(callSid) || {};
          const start = info.startedAt || now;
          const durationSeconds = Math.max(0, Math.round((now - start) / 1000));
          const meta = callInfo.get(callSid) || {};
          appendCallLog({
            callSid, from: meta.from || '', to: meta.to || '',
            startIso: start.toISOString(), endIso: now.toISOString(),
            durationSeconds,
          }).catch(() => { });
          callTimes.delete(callSid);
          callRequests.delete(callSid);
        }
        try { geminiWs.close(); } catch { }
        return;
      }
    } catch (e) { }
  });

  geminiWs.on('message', async (rawData) => {
    try {
      if (rawData instanceof Buffer) {
        // Some versions return raw buffer, convert to string
        rawData = rawData.toString('utf8');
      }

      let evt;
      try {
        evt = JSON.parse(rawData);
      } catch (e) { return; }

      // Evento Setup Complete
      if (evt.setupComplete) {
        console.log('✅ Gemini Setup completado. Iniciando saludo...');
        geminiReady = true;
        // Esperamos un momento para que estabilice la conexión antes de inyectar
        setTimeout(() => {
          safeSendToGemini({
            clientContent: { turns: [{ role: "user", parts: [{ text: "The phone has just been answered. Please give the initial greeting in English." }] }], turnComplete: true }
          });
        }, 800);
        return;
      }

      // Tool Call de Gemini
      if (evt.toolCall) {
        const calls = evt.toolCall.functionCalls || [];
        for (const call of calls) {
          const callId = call.id;
          const toolName = call.name;
          const args = call.args || {};

          let result = {};
          if (toolName === 'hangup_call') {
            result = await hangUpCall(callSid, args.reason || 'fin_de_conversacion');
            safeSendToGemini({
              toolResponse: { functionResponses: [{ id: callId, name: toolName, response: { result } }] }
            });
          } else if (toolName === 'register_request') {
            const meta = callInfo.get(callSid) || {};
            const kind = args.kind;

            let flags = callRequests.get(callSid);
            if (!flags) { flags = { cita: false, humano: false }; callRequests.set(callSid, flags); }
            let alreadyRegistered = false;
            if (kind === 'solicitud agendar cita') {
              if (flags.cita) alreadyRegistered = true; else flags.cita = true;
            } else {
              if (flags.humano) alreadyRegistered = true; else flags.humano = true;
            }

            if (!alreadyRegistered) {
              appendRequest({ phone: meta.from || '', type: kind }).catch(() => { });
            }

            result = { ok: true, phone: meta.from, kind, alreadyRegistered };

            // Mandar confirmación
            safeSendToGemini({
              toolResponse: { functionResponses: [{ id: callId, name: toolName, response: { result } }] }
            });

            // Forzar inyección de respuesta para la herramienta porque Gemini no siempre autogenera por si solo tras tool response
            const triggerResponse = kind === 'solicitud agendar cita'
            ? 'All right, I have noted your request. A member of our team will call you shortly.'
            : 'I have noted that you would like us to call you back as soon as possible.';
            safeSendToGemini({
              clientContent: { turns: [{ role: "user", parts: [{ text: `Dile al usuario: "${triggerResponse}"` }] }], turnComplete: true }
            });
          } else if (toolName === 'validate_policy') {
            const policy_number = args.policy_number || "";
            const meta = callInfo.get(callSid) || {};
            let webhookResult = {};
            console.log("🌐 Llamando a Webhook validate-policy con Póliza:", policy_number);
            try {
              const res = await fetch("https://service156zb.doobot.ai/webhook/elevenlabs/validate-policy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  call_id: callSid || "CA_" + Math.random().toString(36).substring(7),
                  conversation_id: "conv_" + Math.random().toString(36).substring(7),
                  phone_from: meta.from || "+34000000000",
                  policy_number: policy_number
                })
              });
              const txt = await res.text();
              try {
                let parsed = JSON.parse(txt);
                // Extraer del array si viene como [ { ... } ]
                if (Array.isArray(parsed) && parsed.length > 0) {
                  parsed = parsed[0];
                }
                // Extraer el JSON real que suele venir dentro de 'response_json'
                if (parsed && typeof parsed.response_json === 'string') {
                  webhookResult = JSON.parse(parsed.response_json);
                } else {
                  webhookResult = parsed;
                }
              } catch (e) {
                webhookResult = { status: txt || "Respuesta vacía" };
              }
              console.log("✅ Webhook policy respondió:", webhookResult);
            } catch (e) {
              console.error("🛑 Error contactando webhook de pólizas:", e);
              webhookResult = { error: "El servidor de pólizas no está disponible en este momento." };
            }

            safeSendToGemini({
              toolResponse: { functionResponses: [{ id: callId, name: toolName, response: { result: webhookResult } }] }
            });

            // Forzar a Gemini a decir la respuesta que dió el endpoint en su siguiente turno
            safeSendToGemini({
              clientContent: { 
                turns: [{ 
                  role: "user", 
                  parts: [{ 
                    text: `This is the information retrieved from the database for the patient's policy: ${JSON.stringify(webhookResult)}. Explain it to the patient kindly and briefly in English, answering their question.` 
                  }] 
                }], 
                turnComplete: true 
              }
            });
          }
        }
      }

      // Audio o Transcripción de Gemini
      if (evt.serverContent) {
        if (evt.serverContent.interrupted) {
          console.log("🤫 El usuario ha hablado (Barge-in). Cortando voz del bot...");
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          }
        }

        if (evt.serverContent.modelTurn) {
          const parts = evt.serverContent.modelTurn.parts || [];
          for (const pt of parts) {
            // Es audio en vivo
            if (pt.inlineData && pt.inlineData.data) {
              const audioData = encodeGeminiToTwilio(pt.inlineData.data);
              if (audioData && streamSid) {
                sendTwilioAudio(twilioWs, streamSid, audioData);
              }
            }
          }
        }
      } // Missing bracket
    } catch (e) {
      console.error('🛑 Error processando WS de Gemini:', e);
    }
  });

  geminiWs.on('close', (code, reason) => {
    console.log('🔌 Gemini WebSocket cerrado con código:', code, 'Motivo:', reason?.toString() || 'sin especificar');
    try { twilioWs.close(); } catch { }
  });
  geminiWs.on('error', (err) => console.error('🛑 Gemini error:', err));
});

process.on('unhandledRejection', (r) => console.error('🛑 UnhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('🛑 UncaughtException:', e));

server.listen(PORT, () => {
  console.log(`🚀 Servidor Gemini Live MMultimodal en http://localhost:${PORT}`);
  console.log(`👉 Configura Twilio (POST): ${PUBLIC_HOST.replace(/\/+$/, '')}/voice`);
});
