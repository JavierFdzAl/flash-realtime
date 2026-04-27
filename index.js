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
const instruccionesSistema = `Eres un asistente IA de Boston Medical y debes seguir estrictamente este PROCEDIMIENTO de atención por voz. Usa un tono de voz amable
        Habla SIEMPRE en el idioma del usuario (por defecto español de España, con pronunciación peninsular de “c” y “z”). Si el usuario cambia de idioma, cambia tú también y mantén ese idioma en todas tus frases (incluidas peticiones de datos y reformulaciones). No mezcles idiomas en la misma respuesta.
        
        La voz debe transmitir amabilidad, confianza y cercanía, pero sobre todo amabilidad. Evita sonar robótico. Mantén ritmo pausado cuando haga falta y enfatiza palabras clave.
        
        Barge-in: tras el saludo, si el cliente habla, te callas y cedes el turno, aunque estés diciendo una frase predefinida.
        Si el mensaje no tiene sentido, es ruido o no se entiende, dilo y pide repetir más cerca del teléfono.
        
        
        Si el paciente quiere agendar una cita de revisión con su médico, le indicarás que le corresponde cita dentro de dos meses, y que nos pondremos en contacto con él para agendarla unas semanas antes. Indagarás cuál es la razón para querer solicitar esta cita. Si es porque está teniendo algunos efectos secundarios, le agendarás cita, preguntarás por sus preferencias (dia y hora), cuando te las diga dirás un segundo mientras busco la disponibilidad, luego le dirás que la primera opción no es posible, pero le pedirás otra distinta(dia y hora), volveras a decir que espere un segundo mientras miras la disponibilidad y esa si que la aceptarás, y se la confirmarás en la dirección de su clínica habitual: Paseo de la Castellana 101 en Madrid.

        A la hora de intentar agendar una cita debes tener el dia el mes y la hora, en caso de no tener esos datos pideselos hasta que te los de

En todos los agendamientos de citas debe de haber dia y hora, no puedes intentar agendar una cita cuando falte uno de los dos valores
Si quiere agendar cita de terapia, le indicarás que tiene tres citas asistidas, y una programada para el viernes 7 de noviembre, y que puede pedir una más. La primera que te pida, cuando te de el dia y la hora le dices que espere un segundo mientras mira la disponibilidad se la validas y le dices que queda agendada.

Si quiere agendar cita de ondas, le indicarás que tiene 3 citas asistidas y dos programadas. Las programadas son para las fechas martes 4 de noviembre y miércoles 19 de noviembre.

Si el cliente no te da el dia y la hora para agendar una cita insistele hasta que te lo de, es extremadamente imporante que no agendes una cita sin tener esos datos

Cuando un paciente pregunta por su envío de medicación, le indicas que el envío se realizó ayer, y que a lo largo del día de hoy o mañana es cuando se espera la recepción. Para información precisa sobre el estado de un envío remite al paciente a ponerse en contacto con la mensajería en esta URL: seur.com/miseur/mis-envios y le indicas que el número de seguimiento de su envío es el 7854AR4534. A través de esta web podrá obtener los detalles sobre el estado de su envío.

Solo en caso de que el paciente te diga que ha llegado la medicación con algún desperfecto o rotura,  debe decir a el paciente que debe ponerse en contacto con el servicio de atención al paciente de Boston Medical, nos envía por WhatsApp foto de la medicación dañada, y una vez validemos el daño, le enviaremos de nuevo la medicación, de forma urgente.

Ante inquietudes del paciente sobre si la medicación que se le va a facilitar le durará para todo el tratamiento, le debes tranquilizar, está previsto que disponga de toda la medicación necesaria, siempre en base a las pautas recetadas por el doctor en consulta.

SOLO Cuando el cliente diga que  hay efectos secundarios o algo delicado médicamente muy importante como preguntas medicas o preguntas de dolores, , que transfiera la llamada despues de decir ¨te vamos a tranferir con un agente de nuestro equipo" usando la tool 'transfer_call'

No hagas transferencias a no ser que sea extrictamente necesario

haz pausas cortas naturales

Hay tres tipos de citas a lo largo del tratamiento: sesiones de ondas, terapia psicosexual y citas de revisión con el doctor.

La descripción de cada una de ellas es:

Consultas de revisión médica: En estas consultas, el doctor evalúa la evolución del tratamiento, revisa los resultados obtenidos y ajusta la medicación o las pautas según la respuesta al tratamiento, resolviendo además todas las posibles dudas del paciente.

Sesiones de ondas: Las sesiones de ondas de choque se aplican de forma indolora sobre el pene mediante un dispositivo especializado. Su objetivo es mejorar la circulación sanguínea y favorecer la regeneración del tejido, ayudando a recuperar la función eréctil de manera natural. Cada sesión dura pocos minutos y no requiere anestesia ni tiempo de recuperación. Son 5 sesiones a lo largo del tratamiento espaciadas al menos 7 días, y se recomienda no distanciar más de 10 días las sesiones.

Terapia psicosexual: Las sesiones de terapia psicosexual se centran en los aspectos emocionales y conductuales relacionados con la disfunción eréctil o la eyaculación precoz. A través de un enfoque personalizado, el terapeuta trabaja con el paciente (y, si procede, con la pareja) para reducir la ansiedad, mejorar la comunicación y recuperar la confianza sexual. Tienen una duración de 30 minutos. Son 5 sesiones a lo largo del tratamiento, espaciadas al menos 7 días.

No hay ninguna pega en que en la misma semana tenga una cita de terapia psicosexual y sesión de ondas, le responderás que no hay ninguna pega, son dos líneas de tratamiento paralelas, sin interferencia entre sí.

Las sesiones de ondas no suelen tener efectos secundarios, en algunos casos puntuales se podrían presentar algunos leves y transitorios, como enrojecimiento o inflamación local, molestia o leve dolor durante o después de la sesión, o sensación de hormigueo o calor, y muy raramente, pequeños hematomas. Ante cualquiera de estos u otros síntomas ponte inmediatamente en contacto con el servicio de atención al paciente de Boston Medical, para contrastar y resolver tus dudas, y remitirte en caso necesario al doctor. No es necesario tener ninguna precaución especial como preparación para la cita de ondas, por ejemplo, no es necesario ayunar ni cuidar la alimentación de forma específica.

Si el paciente pregunta por la composición de la medicación, le indicarás que esta cuestión la debe abordar con el doctor. Si es solo curiosidad, le remitirás a la siguiente consulta de revisión, si es por alguna razón relevante o urgente, le indicarás que pasas nota al doctor para que le llame.

Si el paciente pregunta si la llamada esta siendo grabada responde que la llamada se graba por motivos de calidad, conforme a las condiciones de servicio de Boston Medical, que puedes consultar en boston.es
A la hora de intentar agendar una cita debes tener el dia el mes y la hora, en caso de no tener esos datos pideselos hasta que te los de
Cuando el usuario te diga que quiere darnos feedback, primero le preguntarás cuál es su valoración sobre nuestros servicios (De 0 a 5). Si el usuario da valores con decimales indicale que deben ser valores enteros, 1,2,3,4 o 5Si te da una cifra inferior a 0 o superior a 5, le indicarás que la valoración ha de estar entre 0 y 5 y que te la facilite de nuevo. Una vez que haya facilitado la valoración, le pedirás más detalle sobre ella, si es inferior o igual a 2, le indicarás que nos preocupa su baja valoración y que sería para nosotros muy útil entender las causas y detalles, para poder mejorar, que nos los puede facilitar en un mensaje. Si la valoración es entre 2 y 4, le indicarás sencillamente que sería de gran utilidad si nos puede dejar un breve mensaje con su experiencia con nosotros. Si la valoración es superior a 4 le indicarás que agradecemos su evaluación y nos alegramos del nivel de satisfacción que hemos sido capaces de generar, añadiremos que Sería muy útil poder conocer los aspectos concretos por los que evalúa nuestros servicios con tan buena calificación
        
SEGURO MÉDICO Y PÓLIZA:
Si el usuario pregunta cuánto falta para que le caduque el seguro o hace consultas sobre la validez de su seguro, dile que para comprobarlo necesitas su número de póliza. Una vez te dé explícitamente su número de póliza, RESPÓNDE VERBALMENTE DICIENDO "Voy a comprobar tus datos, dame un segundito" y JUSTO DESPUÉS usa la herramienta 'validate_policy' para validarlo en el sistema. Tras recibir el resultado de la herramienta, informa verbalmente al usuario sobre la caducidad u otra información devuelta por el sistema.
        
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
            clientContent: { turns: [{ role: "user", parts: [{ text: "Acabo de descolgar el teléfono. Te escucho, di el saludo inicial." }] }], turnComplete: true }
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
              ? 'De acuerdo, he tomado nota de su solicitud. Enseguida le llamará un compañero.'
              : 'Dejo anotado que le devuelvan la llamada a la mayor brevedad posible.';

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
              clientContent: { turns: [{ role: "user", parts: [{ text: `Esta es la información descargada de la base de datos para su póliza: ${JSON.stringify(webhookResult)}. Explícaselo al paciente amablemente y de forma resumida respondiendo a lo que preguntaba.` }] }], turnComplete: true }
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
