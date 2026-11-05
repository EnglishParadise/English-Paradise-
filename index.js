import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v23.0';
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// First-version in-memory state. This resets when the process restarts.
const orderState = new Map();
const dailyLessonSubscribers = new Set();
const recentMessageIds = new Set();

const lessons = [
  {
    title: 'Lesson 1: Introduce yourself',
    text: 'Useful pattern: “My name is ___. I am from ___. I am learning English.”\\nTelugu: నా పేరు ___. నేను ___ నుండి వచ్చాను. నేను ఇంగ్లీష్ నేర్చుకుంటున్నాను.\\nPractice: Write three sentences introducing yourself.'
  },
  {
    title: 'Lesson 2: Everyday requests',
    text: 'Say: “Could you please help me?” / “దయచేసి నాకు సహాయం చేయగలరా?”\\nSay: “Could you repeat that, please?” / “దయచేసి అది మళ్లీ చెప్పగలరా?”\\nPractice: Make one polite request in English.'
  },
  {
    title: 'Lesson 3: Talking about routines',
    text: 'Pattern: “I usually ___ in the morning.” Example: “I usually read in the morning.”\\nTelugu: నేను సాధారణంగా ఉదయం ___ చేస్తాను.\\nPractice: Write two sentences about your daily routine.'
  }
];

const quizQuestions = [
  { q: 'Choose the correct sentence:', options: ['She go to college.', 'She goes to college.', 'She going to college.'], answer: 1, explanation: 'With he/she/it in the simple present, use the verb + s/es: “She goes.”' },
  { q: 'What is the past tense of “teach”?', options: ['teached', 'taught', 'teaching'], answer: 1, explanation: '“Teach” is irregular; its past tense is “taught.”' },
  { q: 'Choose the polite request:', options: ['Give me notes now.', 'Could you please share the notes?', 'You share notes.'], answer: 1, explanation: '“Could you please…?” is a polite request.' }
];
const quizState = new Map();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function graphRequest(path, options = {}) {
  const token = requiredEnv('WHATSAPP_TOKEN');
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('WhatsApp Graph API error:', response.status, JSON.stringify(payload));
    throw new Error(`WhatsApp API request failed (${response.status})`);
  }
  return payload;
}

async function sendText(to, body) {
  return graphRequest(`${requiredEnv('PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: String(body).slice(0, 4000) }
    })
  });
}

async function sendDocument(to, url, filename, caption) {
  return graphRequest(`${requiredEnv('PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { link: url, filename, caption }
    })
  });
}

function menuText() {
  return [
    '🌿 *Welcome to English Paradise!*',
    '',
    'Choose a feature by sending a command:',
    '1. `tutor your question` — AI English Tutor',
    '2. `translate your text` — English ↔ Telugu',
    '3. `quiz` — MCQ practice',
    '4. `notes` — PDF study notes',
    '5. `lesson` — Daily English lesson',
    '6. `order book title` — Book order enquiry',
    '7. `subscribe` — Receive daily lesson updates',
    '8. Send a voice note for transcription and English help.',
    '',
    'Example: `translate I am going to college.`'
  ].join('\\n');
}

async function tutor(question) {
  if (!openai) return 'AI tutoring is not configured yet. The administrator must add OPENAI_API_KEY to the server environment.';
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: 'You are English Paradise, a kind English tutor for learners in India. Explain clearly with simple English. When helpful, include a short Telugu explanation. Correct grammar gently. Keep answers practical and concise. Do not invent facts.'
      },
      { role: 'user', content: question }
    ]
  });
  return response.choices[0]?.message?.content?.trim() || 'Sorry, I could not prepare an answer. Please try again.';
}

async function translate(text) {
  if (!openai) return 'Translation needs OPENAI_API_KEY to be configured by the administrator.';
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'Translate the user text between English and Telugu. Detect the source language automatically. Return the translation first, then one brief note only if useful. Preserve meaning and tone.'
      },
      { role: 'user', content: text }
    ]
  });
  return response.choices[0]?.message?.content?.trim() || 'Sorry, I could not translate that text.';
}

async function transcribeVoice(mediaId) {
  if (!openai) throw new Error('Voice transcription needs OPENAI_API_KEY.');
  const metadata = await graphRequest(mediaId, { method: 'GET' });
  if (!metadata.url) throw new Error('WhatsApp did not return a media URL.');
  const audioResponse = await fetch(metadata.url, {
    headers: { Authorization: `Bearer ${requiredEnv('WHATSAPP_TOKEN')}` }
  });
  if (!audioResponse.ok) throw new Error('Could not download the WhatsApp audio.');
  const contentType = audioResponse.headers.get('content-type') || 'audio/ogg';
  const extension = contentType.includes('mpeg') ? 'mp3'
    : contentType.includes('mp4') ? 'm4a'
    : contentType.includes('wav') ? 'wav' : 'ogg';
  const buffer = Buffer.from(await audioResponse.arrayBuffer());
  const file = new File([buffer], `voice.${extension}`, { type: contentType });
  const result = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    prompt: 'English learning voice message. The speaker may use English or Telugu.'
  });
  return result.text || '';
}

async function handleQuiz(to) {
  const current = quizState.get(to) ?? 0;
  if (current >= quizQuestions.length) {
    quizState.delete(to);
    await sendText(to, '🎉 Quiz completed! Send `quiz` to try again.');
    return;
  }
  const item = quizQuestions[current];
  quizState.set(to, current + 1);
  await sendText(to, `📝 *Question ${current + 1}/${quizQuestions.length}*\\n${item.q}\\n\\nA) ${item.options[0]}\\nB) ${item.options[1]}\\nC) ${item.options[2]}\\n\\nReply A, B, or C.`);
}

async function processText(from, rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  if (quizState.has(from) && /^[abc]$/i.test(text)) {
    const qIndex = quizState.get(from) - 1;
    const item = quizQuestions[qIndex];
    if (item) {
      const correct = text.toUpperCase().charCodeAt(0) - 65 === item.answer;
      await sendText(from, `${correct ? '✅ Correct!' : `❌ Not quite. Correct answer: ${String.fromCharCode(65 + item.answer)}.`}\\n${item.explanation}`);
      await handleQuiz(from);
      return;
    }
  }

  if (lower === 'hi' || lower === 'hello' || lower === 'menu' || lower === 'start') {
    await sendText(from, menuText());
    return;
  }
  if (lower === 'quiz') {
    quizState.set(from, 0);
    await handleQuiz(from);
    return;
  }
  if (lower === 'notes' || lower === 'pdf' || lower === 'pdf notes') {
    const notes = [
      ['Grammar Notes', process.env.GRAMMAR_PDF_URL],
      ['Vocabulary Notes', process.env.VOCABULARY_PDF_URL],
      ['Intermediate English Notes', process.env.INTERMEDIATE_PDF_URL]
    ].filter(([, url]) => url);
    if (!notes.length) {
      await sendText(from, '📚 PDF notes are not linked yet. The administrator should add GRAMMAR_PDF_URL, VOCABULARY_PDF_URL, and/or INTERMEDIATE_PDF_URL in the server environment.');
    } else {
      await sendText(from, '📚 *English Paradise PDF Notes*\\n' + notes.map(([name, url]) => `${name}: ${url}`).join('\\n'));
    }
    return;
  }
  if (lower === 'lesson' || lower === 'daily lesson') {
    const index = Math.floor(Date.now() / 86400000) % lessons.length;
    await sendText(from, `📖 *${lessons[index].title}*\\n\\n${lessons[index].text}`);
    return;
  }
  if (lower === 'subscribe') {
    dailyLessonSubscribers.add(from);
    await sendText(from, '✅ You are subscribed to daily lesson updates for this running bot instance. Send `unsubscribe` to stop. This first version stores subscriptions in memory, so they reset if the server restarts.');
    return;
  }
  if (lower === 'unsubscribe') {
    dailyLessonSubscribers.delete(from);
    await sendText(from, 'You have been unsubscribed from daily lesson updates.');
    return;
  }
  if (lower.startsWith('translate ')) {
    await sendText(from, await translate(text.slice(10).trim()));
    return;
  }
  if (lower.startsWith('tutor ')) {
    await sendText(from, await tutor(text.slice(6).trim()));
    return;
  }
  if (lower === 'order' || lower.startsWith('order ')) {
    const title = text.slice(5).trim();
    if (title) {
      orderState.set(from, { title, createdAt: new Date().toISOString() });
      await sendText(from, `📦 *Book order enquiry received*\\nBook: ${title}\\n\\nPlease reply with your name and preferred contact method. An administrator must confirm availability, price, delivery, and payment before the order is final.`);
    } else {
      await sendText(from, 'To enquire about a book, send: `order Book Title`');
    }
    return;
  }
  if (orderState.has(from)) {
    const order = orderState.get(from);
    orderState.set(from, { ...order, customerDetails: text, updatedAt: new Date().toISOString() });
    await sendText(from, 'Thank you. Your details have been noted for this running bot instance. An administrator must contact you to confirm the order. Do not send payment-card details or passwords here.');
    return;
  }

  await sendText(from, 'I can help you learn English! Send `menu` to see commands, `tutor` followed by a question, `translate` followed by text, or send `quiz`.');
}

async function processMessage(message) {
  const from = message.from;
  if (!from || !message.id || recentMessageIds.has(message.id)) return;
  recentMessageIds.add(message.id);
  if (recentMessageIds.size > 5000) recentMessageIds.clear();

  try {
    if (message.type === 'text') {
      await processText(from, message.text?.body || '');
      return;
    }
    if (message.type === 'audio' && message.audio?.id) {
      await sendText(from, '🎙️ I received your voice note. I am transcribing it now…');
      const transcript = await transcribeVoice(message.audio.id);
      if (transcript) {
        await sendText(from, `🗣️ *Transcript*\\n${transcript}`);
        await sendText(from, await tutor(`Help me understand or improve this spoken message. Give a corrected version and a short explanation: ${transcript}`));
      } else {
        await sendText(from, 'I could not detect speech clearly. Please try sending the voice note again.');
      }
      return;
    }
    await sendText(from, 'I can process text and voice notes in this first version. Send `menu` to see available features.');
  } catch (error) {
    console.error('Message handling failed:', error);
    await sendText(from, 'Sorry, something went wrong while processing your message. Please try again later.').catch(() => {});
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'English Paradise WhatsApp Bot' }));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(String(challenge));
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  // Acknowledge promptly so Meta does not keep retrying the webhook.
  res.sendStatus(200);
  const entries = req.body?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const messages = change.value?.messages || [];
      for (const message of messages) await processMessage(message);
    }
  }
});

app.post('/admin/daily-lesson', async (req, res) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || req.get('authorization') !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const index = Math.floor(Date.now() / 86400000) % lessons.length;
  const lesson = lessons[index];
  const results = await Promise.allSettled(
    [...dailyLessonSubscribers].map(to => sendText(to, `📖 *${lesson.title}*\\n\\n${lesson.text}`))
  );
  return res.json({
    sent: results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length,
    note: 'Subscriber list is in memory and resets when the process restarts.'
  });
});

app.listen(PORT, () => {
  console.log(`English Paradise WhatsApp Bot listening on port ${PORT}`);
});
