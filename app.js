import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://ttjtxmqojzxkpjiixjst.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0anR4bXFvanp4a3BqaWl4anN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4Mzk1MjMsImV4cCI6MjA5MzQxNTUyM30.EqHGGrEFcxnN_XOD9HiJZXrIChxvEk-jzXa6R3NROy0';
const STORAGE_BUCKET = 'job-videos';
const JOB_LOGS_TABLE = 'job_logs';

let supabase = null;
let recordingTimerId = null;
let cameraStream = null;
let mediaRecorder = null;
let activeObjectUrl = null;

const state = {
  chunks: [],
  recordedBlob: null,
  recordedAt: null,
  location: null,
  recorderMimeType: '',
  session: null,
  currentUser: null
};

const $ = (id) => document.getElementById(id);
const views = [...document.querySelectorAll('[data-view]')];
const appStatus = $('appStatus');
const pwaStatus = $('pwaStatus');
const authForm = $('authForm');
const authSignedOut = $('authSignedOut');
const authSignedIn = $('authSignedIn');
const authBadge = $('authBadge');
const currentTechEmail = $('currentTechEmail');
const authEmail = $('authEmail');
const cameraPreview = $('cameraPreview');
const recordedPreview = $('recordedPreview');
const cameraFallback = $('cameraFallback');
const mobileCapture = $('mobileCapture');
const startRecordingButton = $('startRecording');
const stopRecordingButton = $('stopRecording');
const recordingLamp = $('recordingLamp');
const recordingTimer = $('recordingTimer');
const uploadPanel = $('uploadPanel');
const uploadLabel = $('uploadLabel');
const uploadPercent = $('uploadPercent');
const uploadBar = $('uploadBar');
const uploadJobButton = $('uploadJob');
const historyList = $('historyList');
const videoDialog = $('videoDialog');
const historyPlayer = $('historyPlayer');
const authRequiredControls = [$('headerHistory'), $('homeHistory'), $('newWalkthrough')].filter(Boolean);

init();

async function init() {
  bindEvents();
  showView('home');
  await registerServiceWorker();
  await initSupabase();
}

async function initSupabase() {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    applyAuthSession(data.session);
    supabase.auth.onAuthStateChange((_event, session) => applyAuthSession(session));
  } catch (error) {
    console.error(error);
    setStatus('Supabase failed to initialize. Check project settings.', 'error');
  }
}

function bindEvents() {
  $('brandHome').addEventListener('click', () => showView('home'));
  $('headerHistory').addEventListener('click', showHistory);
  $('homeHistory').addEventListener('click', showHistory);
  $('newWalkthrough').addEventListener('click', beginWalkthrough);
  $('recordBack').addEventListener('click', () => { stopCameraStream(); resetRecordingUi(); showView('home'); });
  $('detailsBack').addEventListener('click', beginWalkthrough);
  $('historyBack').addEventListener('click', () => showView('home'));
  $('refreshHistory').addEventListener('click', loadHistory);
  $('successNew').addEventListener('click', beginWalkthrough);
  $('successHistory').addEventListener('click', showHistory);
  $('closePlayer').addEventListener('click', closeVideoPlayer);
  $('jobForm').addEventListener('submit', uploadJob);
  authForm.addEventListener('submit', handleAuthSubmit);
  $('headerSignOut').addEventListener('click', signOut);
  $('homeSignOut').addEventListener('click', signOut);
  startRecordingButton.addEventListener('click', startRecording);
  stopRecordingButton.addEventListener('click', stopRecording);
  mobileCapture.addEventListener('change', handleCapturedFile);
}

function applyAuthSession(session) {
  state.session = session || null;
  state.currentUser = session?.user || null;
  updateAuthUi();
  setStatus(state.currentUser ? 'Signed in. Camera, GPS, storage, and history are ready.' : 'Sign in before recording or viewing job history.', state.currentUser ? 'ok' : 'warn');
}

function updateAuthUi() {
  const signedIn = Boolean(state.currentUser);
  authSignedOut.classList.toggle('hidden', signedIn);
  authSignedIn.classList.toggle('hidden', !signedIn);
  $('headerSignOut').classList.toggle('hidden', !signedIn);
  authBadge.textContent = signedIn ? 'Signed In' : 'Signed Out';
  currentTechEmail.textContent = state.currentUser?.email || '';
  authRequiredControls.forEach((control) => { control.disabled = !signedIn; });
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const email = String(form.get('email') || '').trim();
  const password = String(form.get('password') || '');
  const action = event.submitter?.dataset.authAction || 'sign-in';
  if (!email || password.length < 6) return setStatus('Enter an email and a password with at least 6 characters.', 'error');
  setAuthBusy(true);
  try {
    if (action === 'sign-up') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) applyAuthSession(data.session);
      setStatus(data.session ? 'Account created. You are signed in.' : 'Account created. Check your email if confirmation is required.', 'ok');
      return;
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    applyAuthSession(data.session);
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Authentication failed.', 'error');
  } finally {
    setAuthBusy(false);
  }
}

async function signOut() {
  try {
    stopCameraStream();
    resetRecordingUi();
    resetRecordingState();
    closeVideoPlayer();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    showView('home');
    setStatus('Signed out.', 'warn');
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Could not sign out.', 'error');
  }
}

function requireSignedIn(message) {
  if (state.currentUser) return true;
  setStatus(message || 'Sign in before using JobSafeCam.', 'warn');
  showView('home');
  authEmail.focus();
  return false;
}

async function beginWalkthrough() {
  if (!requireSignedIn('Sign in before recording a jobsite walkthrough.')) return;
  resetRecordingState();
  showView('recording');
  setStatus('Requesting camera access. Use the rear camera for the site walkthrough.', 'info');
  await startCameraStream();
}

async function startCameraStream() {
  resetRecordingUi();
  stopCameraStream();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return showCameraFallback('This browser cannot stream the camera directly. Use the camera app capture button.');
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    cameraPreview.srcObject = cameraStream;
    cameraFallback.classList.add('hidden');
    startRecordingButton.disabled = false;
    setStatus('Camera ready. Tap START RECORDING when the site is framed.', 'ok');
  } catch (error) {
    console.error(error);
    showCameraFallback('Camera permission was denied or unavailable. Use the camera app capture button.');
  }
}

function showCameraFallback(message) {
  cameraFallback.classList.remove('hidden');
  startRecordingButton.disabled = true;
  stopRecordingButton.disabled = true;
  setStatus(message, 'warn');
}

function startRecording() {
  if (!cameraStream) return showCameraFallback('No camera stream is active. Use the camera app capture button.');
  try {
    state.chunks = [];
    state.recordedAt = new Date();
    state.recorderMimeType = pickBestMimeType();
    const options = { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
    if (state.recorderMimeType) options.mimeType = state.recorderMimeType;
    mediaRecorder = new MediaRecorder(cameraStream, options);
    mediaRecorder.addEventListener('dataavailable', (event) => { if (event.data?.size > 0) state.chunks.push(event.data); });
    mediaRecorder.start(1000);
    startRecordingButton.disabled = true;
    stopRecordingButton.disabled = false;
    recordingLamp.classList.remove('hidden');
    recordingLamp.classList.add('flex');
    startTimer();
    setStatus('Recording. Pan slowly across existing conditions before work starts.', 'warn');
  } catch (error) {
    console.error(error);
    showCameraFallback('Recording could not start in this browser. Use the camera app capture button.');
  }
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  stopRecordingButton.disabled = true;
  setStatus('Finalizing video and grabbing GPS metadata.', 'info');
  const stopped = new Promise((resolve) => mediaRecorder.addEventListener('stop', resolve, { once: true }));
  mediaRecorder.stop();
  await stopped;
  stopTimer();
  stopCameraStream();
  state.recordedBlob = new Blob(state.chunks, { type: state.recorderMimeType || 'video/mp4' });
  await prepareDetailsView();
}

async function handleCapturedFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  resetRecordingState();
  state.recordedBlob = file;
  state.recordedAt = new Date(file.lastModified || Date.now());
  state.recorderMimeType = file.type || 'video/mp4';
  stopCameraStream();
  await prepareDetailsView();
}

async function prepareDetailsView() {
  if (!state.recordedBlob?.size) {
    setStatus('No video was captured. Please record again.', 'error');
    return beginWalkthrough();
  }
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = URL.createObjectURL(state.recordedBlob);
  recordedPreview.src = activeObjectUrl;
  $('recordedAtText').textContent = formatDateTime(state.recordedAt);
  $('videoSizeText').textContent = formatBytes(state.recordedBlob.size);
  $('geoText').textContent = 'Acquiring';
  showView('details');
  state.location = await getPreciseLocation(false);
  $('geoText').textContent = state.location ? `${state.location.latitude.toFixed(5)}, ${state.location.longitude.toFixed(5)}` : 'Required before upload';
  setStatus('Add client details. GPS will be required before upload.', state.location ? 'ok' : 'warn');
}

async function uploadJob(event) {
  event.preventDefault();
  if (!requireSignedIn('Sign in before uploading a job log.')) return;
  if (!state.recordedBlob) return setStatus('Record a video before uploading.', 'error');
  const form = new FormData(event.currentTarget);
  const clientName = String(form.get('clientName') || '').trim();
  const address = String(form.get('jobAddress') || '').trim();
  const notes = String(form.get('notes') || '').trim();
  if (!clientName || !address) return setStatus('Client Name and Job Address are required.', 'error');
  setUploading(true);
  setUploadProgress(1, 'Checking GPS');
  try {
    state.location = state.location || await getPreciseLocation(true);
    if (!state.location) throw new Error('GPS permission is required so each upload has a liability-grade geotag.');
    $('geoText').textContent = `${state.location.latitude.toFixed(5)}, ${state.location.longitude.toFixed(5)}`;
    setUploadProgress(5, 'Compressing video');
    const compressedBlob = await compressVideo(state.recordedBlob);
    const recordedAt = state.recordedAt || new Date();
    const extension = fileExtensionForType(compressedBlob.type || state.recorderMimeType);
    const cleanAddress = slugify(address).slice(0, 48) || 'jobsite';
    const uniqueId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const technicianId = state.currentUser.id;
    const storagePath = `${technicianId}/pre-work/${recordedAt.toISOString().slice(0, 7)}/${recordedAt.toISOString().replace(/[:.]/g, '-')}-${cleanAddress}-${uniqueId}.${extension}`;
    const contentType = compressedBlob.type || 'video/mp4';
    await uploadBlobWithProgress(storagePath, compressedBlob, contentType);
    const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const location = { latitude: state.location.latitude, longitude: state.location.longitude, accuracy_meters: state.location.accuracy || null, captured_at: state.location.timestamp };
    const { error } = await supabase.from(JOB_LOGS_TABLE).insert({ user_id: technicianId, client_name: clientName, address, notes, video_url: publicUrlData?.publicUrl || '', video_path: storagePath, location, recorded_at: recordedAt.toISOString(), created_at: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, original_size_bytes: state.recordedBlob.size, uploaded_size_bytes: compressedBlob.size, mime_type: contentType, user_agent: navigator.userAgent });
    if (error) throw error;
    setUploadProgress(100, 'Upload complete');
    setStatus('Success. Site log uploaded with video, GPS, and timestamp metadata.', 'ok');
    event.currentTarget.reset();
    showView('success');
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Upload failed. Check Supabase policies and network connection.', 'error');
  } finally {
    setUploading(false);
  }
}

function uploadBlobWithProgress(path, blob, contentType) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const uploadUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/${STORAGE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Authorization', `Bearer ${state.session?.access_token || SUPABASE_ANON_KEY}`);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('Cache-Control', '3600');
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.addEventListener('progress', (event) => { if (event.lengthComputable) setUploadProgress(8 + Math.round((event.loaded / event.total) * 82), 'Uploading video'); });
    xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(parseSupabaseStorageError(xhr))));
    xhr.addEventListener('error', () => reject(new Error('Network error while uploading to Supabase Storage.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload was aborted.')));
    xhr.send(blob);
  });
}

async function showHistory() {
  if (!requireSignedIn('Sign in before viewing job history.')) return;
  showView('history');
  await loadHistory();
}

async function loadHistory() {
  clearHistory();
  if (!state.currentUser) return renderHistoryMessage('Sign in to load your job history.');
  renderHistoryMessage('Loading jobs...');
  try {
    const { data, error } = await supabase.from(JOB_LOGS_TABLE).select('*').eq('user_id', state.currentUser.id).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    clearHistory();
    if (!data?.length) return renderHistoryMessage('No site walkthroughs logged yet.');
    data.forEach(renderHistoryItem);
  } catch (error) {
    console.error(error);
    clearHistory();
    renderHistoryMessage('History failed to load. Check Supabase table policies.');
  }
}

function renderHistoryItem(job) {
  const item = document.createElement('article');
  item.className = 'rounded-lg border border-zinc-700 bg-steel p-4';
  const address = document.createElement('h3');
  address.className = 'text-2xl font-black tracking-normal text-white';
  address.textContent = job.address || 'Unknown address';
  const timestamp = document.createElement('p');
  timestamp.className = 'mt-1 text-sm font-bold uppercase tracking-normal text-zinc-400';
  timestamp.textContent = job.recorded_at || job.created_at ? formatDateTime(new Date(job.recorded_at || job.created_at)) : 'Timestamp unavailable';
  const meta = document.createElement('p');
  meta.className = 'mt-2 text-sm font-bold text-zinc-300';
  const lat = typeof job.location?.latitude === 'number' ? job.location.latitude.toFixed(5) : 'GPS';
  const lng = typeof job.location?.longitude === 'number' ? job.location.longitude.toFixed(5) : 'unavailable';
  meta.textContent = `${job.client_name || 'Unknown client'} | ${lat}, ${lng}`;
  const playButton = document.createElement('button');
  playButton.className = 'high-vis-focus mt-4 min-h-16 w-full rounded-lg bg-hazard px-5 text-xl font-black uppercase tracking-normal text-black';
  playButton.type = 'button';
  playButton.textContent = 'Play Video';
  playButton.disabled = !(job.video_path || job.video_url);
  playButton.addEventListener('click', () => openJobVideo(job));
  item.append(address, timestamp, meta, playButton);
  historyList.appendChild(item);
}

async function openJobVideo(job) {
  try {
    if (job.video_path) {
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(job.video_path, 3600);
      if (error) throw error;
      return openVideoPlayer(data.signedUrl);
    }
    openVideoPlayer(job.video_url);
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Could not open video.', 'error');
  }
}

async function getPreciseLocation(required) {
  if (!navigator.geolocation) {
    if (required) throw new Error('GPS is not available in this browser.');
    return null;
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition((position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: new Date(position.timestamp).toISOString() }), (error) => required ? reject(new Error(`GPS permission required: ${error.message}`)) : resolve(null), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

async function compressVideo(inputBlob) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return inputBlob;
  const sourceUrl = URL.createObjectURL(inputBlob);
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  const chunks = [];
  let animationFrameId = null;
  try {
    video.src = sourceUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    await waitForVideoMetadata(video);
    const scale = Math.min(1, 720 / video.videoWidth);
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
    const stream = canvas.captureStream(24);
    const mimeType = pickBestMimeType() || inputBlob.type || 'video/webm';
    const options = { videoBitsPerSecond: 900000, audioBitsPerSecond: 64000 };
    if (MediaRecorder.isTypeSupported?.(mimeType)) options.mimeType = mimeType;
    const recorder = new MediaRecorder(stream, options);
    recorder.addEventListener('dataavailable', (event) => { if (event.data?.size > 0) chunks.push(event.data); });
    const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
    const drawFrame = () => { if (!video.paused && !video.ended) { context.drawImage(video, 0, 0, canvas.width, canvas.height); animationFrameId = requestAnimationFrame(drawFrame); } };
    recorder.start(1000);
    await video.play();
    drawFrame();
    await new Promise((resolve) => video.addEventListener('ended', resolve, { once: true }));
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    const compressedBlob = new Blob(chunks, { type: recorder.mimeType || mimeType });
    return compressedBlob.size > 0 && compressedBlob.size < inputBlob.size ? compressedBlob : inputBlob;
  } catch (error) {
    console.warn('Video compression fell back to original file.', error);
    return inputBlob;
  } finally {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    URL.revokeObjectURL(sourceUrl);
  }
}

function showView(name) { views.forEach((view) => { view.hidden = view.dataset.view !== name; }); }
function setStatus(message, type = 'info') {
  appStatus.textContent = message;
  appStatus.className = 'mb-4 rounded-lg border px-4 py-3 text-sm font-bold';
  const classes = { ok: 'border-green-700 bg-green-950 text-green-100', warn: 'border-orange-700 bg-orange-950 text-orange-100', error: 'border-red-700 bg-red-950 text-red-100', info: 'border-zinc-700 bg-steel text-zinc-200' };
  appStatus.className += ` ${classes[type] || classes.info}`;
}
function setAuthBusy(isBusy) { [...authForm.elements].forEach((element) => { element.disabled = isBusy; }); }
function setUploading(isUploading) { uploadPanel.classList.toggle('hidden', !isUploading); uploadJobButton.disabled = isUploading; [...document.querySelectorAll('#jobForm input, #jobForm textarea')].forEach((element) => { element.disabled = isUploading; }); }
function setUploadProgress(percent, label) { const bounded = Math.max(0, Math.min(100, Math.round(percent))); uploadBar.style.width = `${bounded}%`; uploadPercent.textContent = `${bounded}%`; uploadLabel.textContent = label; }
function stopCameraStream() { if (cameraStream) { cameraStream.getTracks().forEach((track) => track.stop()); cameraStream = null; } cameraPreview.srcObject = null; }
function resetRecordingUi() { startRecordingButton.disabled = true; stopRecordingButton.disabled = true; recordingLamp.classList.add('hidden'); recordingLamp.classList.remove('flex'); recordingTimer.textContent = '00:00'; cameraPreview.removeAttribute('src'); cameraPreview.srcObject = null; cameraFallback.classList.add('hidden'); stopTimer(); }
function resetRecordingState() { state.chunks = []; state.recordedBlob = null; state.recordedAt = null; state.location = null; state.recorderMimeType = ''; setUploadProgress(0, 'Preparing upload'); uploadPanel.classList.add('hidden'); uploadJobButton.disabled = false; if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; } recordedPreview.removeAttribute('src'); recordedPreview.load(); }
function startTimer() { const startedAt = Date.now(); recordingTimer.textContent = '00:00'; recordingTimerId = window.setInterval(() => { const elapsed = Math.floor((Date.now() - startedAt) / 1000); recordingTimer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`; }, 250); }
function stopTimer() { if (recordingTimerId) { clearInterval(recordingTimerId); recordingTimerId = null; } }
function clearHistory() { historyList.replaceChildren(); }
function renderHistoryMessage(message) { const item = document.createElement('div'); item.className = 'rounded-lg border border-zinc-700 bg-steel p-5 text-lg font-black text-zinc-200'; item.textContent = message; historyList.appendChild(item); }
function openVideoPlayer(url) { if (!url) return; historyPlayer.src = url; videoDialog.classList.remove('hidden'); videoDialog.classList.add('flex'); historyPlayer.play().catch(() => {}); }
function closeVideoPlayer() { historyPlayer.pause(); historyPlayer.removeAttribute('src'); historyPlayer.load(); videoDialog.classList.add('hidden'); videoDialog.classList.remove('flex'); }
function waitForVideoMetadata(video) { return new Promise((resolve, reject) => { video.addEventListener('loadedmetadata', resolve, { once: true }); video.addEventListener('error', () => reject(new Error('Could not read video metadata.')), { once: true }); }); }
function pickBestMimeType() { if (!window.MediaRecorder?.isTypeSupported) return ''; return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || ''; }
function fileExtensionForType(type) { return String(type || '').includes('mp4') ? 'mp4' : 'webm'; }
function formatDateTime(date) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date); }
function formatBytes(bytes) { if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); const value = bytes / Math.pow(1024, exponent); return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`; }
function slugify(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function parseSupabaseStorageError(xhr) { try { const body = JSON.parse(xhr.responseText); return body.message || body.error || `Supabase Storage upload failed with HTTP ${xhr.status}.`; } catch { return xhr.responseText || `Supabase Storage upload failed with HTTP ${xhr.status}.`; } }
async function registerServiceWorker() { if (!('serviceWorker' in navigator)) { pwaStatus.textContent = 'Install metadata ready'; return; } try { await navigator.serviceWorker.register('/sw.js'); pwaStatus.textContent = 'PWA shell ready'; } catch (error) { console.warn('Service worker registration failed.', error); pwaStatus.textContent = 'Install metadata ready'; } }
