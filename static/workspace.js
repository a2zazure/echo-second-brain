const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const input = $('#file-input');
const dropzone = $('#dropzone');
const filename = $('#filename');
const processButton = $('#process-btn');
const statusBox = $('#status');
const statusText = $('#status-text');
const errorBox = $('#error');
const results = $('#results');
const welcomeState = $('#welcome-state');
const recordButton = $('#record-btn');
const stopButton = $('#stop-btn');
const recordTime = $('#record-time');
const recordIndicator = $('#record-indicator');
const recordTitle = $('#record-title');
const recordPreview = $('#record-preview');
const recordedAudio = $('#recorded-audio');
const downloadRecording = $('#download-recording');

let selectedFile;
let mediaRecorder;
let microphoneStream;
let recordedChunks = [];
let recordTimer;
let recordStartedAt;
let recordingUrl;
let memories = [];
let chatHistory = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function chooseFile(file) {
  if (!file) return;
  selectedFile = file;
  filename.textContent = file.name;
  processButton.disabled = false;
}

function switchMode(mode) {
  $$('.mode-button').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
  $('#record-mode').classList.toggle('active', mode === 'record');
  $('#upload-mode').classList.toggle('active', mode === 'upload');
}

$$('.mode-button').forEach(button => button.addEventListener('click', () => switchMode(button.dataset.mode)));
input.addEventListener('change', event => chooseFile(event.target.files[0]));
['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault();
  dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault();
  dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', event => chooseFile(event.dataTransfer.files[0]));

function recordingType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function recordingExtension(type) {
  if (type.includes('mp4')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

function updateRecordTime() {
  const seconds = Math.floor((Date.now() - recordStartedAt) / 1000);
  recordTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function releaseMicrophone() {
  if (microphoneStream) microphoneStream.getTracks().forEach(track => track.stop());
  microphoneStream = null;
}

recordButton.addEventListener('click', async () => {
  errorBox.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError('This browser does not support microphone recording.');
    return;
  }
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    const type = recordingType();
    mediaRecorder = type ? new MediaRecorder(microphoneStream, { mimeType: type }) : new MediaRecorder(microphoneStream);
    mediaRecorder.addEventListener('dataavailable', event => {
      if (event.data.size) recordedChunks.push(event.data);
    });
    mediaRecorder.addEventListener('stop', () => {
      const mimeType = mediaRecorder.mimeType || type || 'audio/webm';
      const blob = new Blob(recordedChunks, { type: mimeType });
      const extension = recordingExtension(mimeType);
      const name = `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
      const file = new File([blob], name, { type: mimeType });
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      recordingUrl = URL.createObjectURL(blob);
      recordedAudio.src = recordingUrl;
      downloadRecording.href = recordingUrl;
      downloadRecording.download = name;
      recordPreview.hidden = false;
      recordTitle.textContent = 'Recording ready';
      chooseFile(file);
      releaseMicrophone();
      if (window.confirm('Recording stopped. Add this recording to your second brain now?')) processSelected();
    });
    mediaRecorder.start(1000);
    recordStartedAt = Date.now();
    updateRecordTime();
    recordTimer = setInterval(updateRecordTime, 1000);
    recordButton.hidden = true;
    stopButton.hidden = false;
    recordIndicator.classList.add('recording');
    recordTitle.textContent = 'Listening…';
    processButton.disabled = true;
  } catch (error) {
    releaseMicrophone();
    showError(error.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow access and try again.' : error.message);
  }
});

stopButton.addEventListener('click', () => {
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  clearInterval(recordTimer);
  recordButton.hidden = false;
  stopButton.hidden = true;
  recordIndicator.classList.remove('recording');
});

processButton.addEventListener('click', processSelected);

async function processSelected() {
  if (!selectedFile) return;
  processButton.disabled = true;
  errorBox.hidden = true;
  statusBox.hidden = false;
  statusText.textContent = 'Uploading audio';
  try {
    const form = new FormData();
    form.append('file', selectedFile);
    const response = await fetch('/api/process', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Upload failed');
    statusText.textContent = data.message || 'Uploaded';
    await watchJob(data.job_id);
  } catch (error) {
    showError(error.message);
    statusBox.hidden = true;
    processButton.disabled = false;
  }
}

async function watchJob(jobId) {
  while (true) {
    const response = await fetch(`/api/status/${jobId}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Could not read processing status');
    statusText.textContent = data.message || data.status;
    if (data.status === 'complete') {
      renderMemory(data.result);
      statusBox.hidden = true;
      processButton.disabled = false;
      await Promise.all([loadMemories(), loadGraph()]);
      return;
    }
    if (data.status === 'error') throw new Error(data.message);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function fillList(selector, items, emptyText) {
  const list = $(selector);
  list.innerHTML = '';
  const values = items?.length ? items : [emptyText];
  values.forEach(value => {
    const item = document.createElement('li');
    item.textContent = value;
    list.appendChild(item);
  });
}

function renderMemory(data) {
  const notes = data.notes || {};
  $('#note-title').textContent = notes.title || data.source_name || 'Your notes';
  $('#language').textContent = `Language: ${data.language || 'unknown'}`;
  $('#summary').textContent = notes.summary || 'No summary generated.';
  $('#transcript').textContent = data.transcript || '';
  fillList('#key-points', notes.key_points, 'No key points detected.');
  fillList('#decisions', notes.decisions, 'No clear decisions detected.');
  $('#note-tags').innerHTML = (notes.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  $('#actions').innerHTML = notes.action_items?.length
    ? notes.action_items.map(item => `<tr><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.deadline)}</td></tr>`).join('')
    : '<tr><td colspan="3">No action items detected.</td></tr>';
  welcomeState.hidden = true;
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

async function loadMemories() {
  try {
    const response = await fetch('/api/memories');
    if (!response.ok) throw new Error('Could not load memories');
    memories = (await response.json()).memories || [];
    $('#memory-count').textContent = memories.length;
    renderMemoryList(memories);
  } catch (error) {
    $('#memory-list').innerHTML = `<div class="empty-small">${escapeHtml(error.message)}</div>`;
  }
}

function renderMemoryList(items) {
  const list = $('#memory-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty-small">Your processed notes will appear here.</div>';
    return;
  }
  list.innerHTML = items.map(item => `<button class="memory-item" data-memory-id="${escapeHtml(item.memory_id)}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.summary)}</p><div class="memory-meta">${escapeHtml(formatDate(item.created_at))} · ${escapeHtml(item.language)}</div></button>`).join('');
  $$('.memory-item').forEach(button => button.addEventListener('click', () => openMemory(button.dataset.memoryId)));
}

async function openMemory(memoryId) {
  const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`);
  const data = await response.json();
  if (!response.ok) return showError(data.detail || 'Could not open memory');
  $$('.memory-item').forEach(item => item.classList.toggle('active', item.dataset.memoryId === memoryId));
  renderMemory(data);
}

$('#memory-search').addEventListener('input', event => {
  const query = event.target.value.trim().toLowerCase();
  renderMemoryList(query ? memories.filter(item => `${item.title} ${item.summary} ${(item.tags || []).join(' ')}`.toLowerCase().includes(query)) : memories);
});
$('#refresh-memories').addEventListener('click', () => Promise.all([loadMemories(), loadGraph()]));

async function loadGraph() {
  try {
    const response = await fetch('/api/graph');
    if (!response.ok) throw new Error('Could not load graph');
    const graph = await response.json();
    $('#relation-count').textContent = graph.edge_count || 0;
    const nodes = (graph.nodes || []).filter(node => node.type !== 'memory').slice(0, 18);
    $('#graph-nodes').innerHTML = nodes.length ? nodes.map(node => `<span class="graph-node ${escapeHtml(node.type)}">${escapeHtml(node.label)}</span>`).join('') : '<span class="empty-small">Connections grow with every note.</span>';
    const labels = Object.fromEntries((graph.nodes || []).map(node => [node.id, node.label]));
    const relation = (graph.edges || []).find(edge => edge.relation !== 'mentions');
    $('#graph-relations').textContent = relation ? `${labels[relation.source] || relation.source} → ${relation.relation} → ${labels[relation.target] || relation.target}` : '';
  } catch (_) {
    $('#relation-count').textContent = '0';
  }
}

function appendChat(role, text, sources = []) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  if (sources.length) {
    const sourceRow = document.createElement('div');
    sourceRow.className = 'chat-sources';
    sources.forEach(source => {
      const button = document.createElement('button');
      button.className = 'chat-source';
      button.textContent = source.title;
      button.addEventListener('click', () => openMemory(source.memory_id));
      sourceRow.appendChild(button);
    });
    bubble.appendChild(sourceRow);
  }
  $('#chat-messages').appendChild(bubble);
  $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
  return bubble;
}

async function askMemory(question) {
  const cleanQuestion = question.trim();
  if (!cleanQuestion) return;
  appendChat('user', cleanQuestion);
  chatHistory.push({ role: 'user', content: cleanQuestion });
  const thinking = appendChat('assistant', 'Searching and connecting your memories…');
  $('#chat-send').disabled = true;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: cleanQuestion, history: chatHistory.slice(0, -1).slice(-6) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'The memory assistant could not answer');
    thinking.remove();
    appendChat('assistant', data.answer, data.sources || []);
    chatHistory.push({ role: 'assistant', content: data.answer });
  } catch (error) {
    thinking.textContent = error.message;
  } finally {
    $('#chat-send').disabled = false;
  }
}

$('#chat-form').addEventListener('submit', event => {
  event.preventDefault();
  const question = $('#chat-input').value;
  $('#chat-input').value = '';
  askMemory(question);
});
$$('.prompt-chips button').forEach(button => button.addEventListener('click', () => askMemory(button.dataset.question)));

$$('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const target = button.dataset.copy === 'summary' ? $('#summary').textContent : $('#transcript').textContent;
  await navigator.clipboard.writeText(target);
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1200);
}));

loadMemories();
loadGraph();
