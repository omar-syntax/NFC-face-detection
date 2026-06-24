/**
 * 📊 Smart Attendance System - Tablet Logic
 */

const API_BASE = 'nfc-api.railway.internal';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

// 🔒 FRONTEND-ONLY PASSWORD
const ADMIN_PASS = 'admin123';

// ─── RECOGNITION SETTINGS ───────────────────────────────────────────────────
// Maximum Euclidean distance (0–2) to accept a face as recognized.
// Lower = stricter. face-api default is 0.6, we use 0.5 for reliability.
const CONFIDENCE_THRESHOLD = 0.5;

// Minimum time (ms) between two failed-scan notifications to avoid spam.
const FAIL_COOLDOWN_MS = 3000;

// UI Elements
const video = document.getElementById('video');
const regVideo = document.getElementById('reg-video');
const overlay = document.getElementById('overlay');
const regOverlay = document.getElementById('reg-overlay');
const navScan = document.getElementById('nav-scan');
const navRegister = document.getElementById('nav-register');
const sectionScan = document.getElementById('section-scan');
const sectionRegister = document.getElementById('section-register');
const loader = document.getElementById('loader');
const statusDot = document.querySelector('.status-dot');
const serverMsg = document.getElementById('server-msg');
const btnSave = document.getElementById('btn-save');
const regStatus = document.getElementById('reg-status');

// App State
let labeledFaceDescriptors = [];
let faceMatcher = null;
let currentDescriptor = null;
let isScanMode = true;
let isModelsLoaded = false;
let studentNames = {};           // studentId → name lookup
let scanFrameResetTimer = null; // for auto-clearing scan-frame state

// ─── INIT: Load Models & Data ───────────────────────────────────────────────

async function init() {
    try {
        console.log('🤖 Loading models...');
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);
        isModelsLoaded = true;
        loader.classList.add('hidden');
        console.log('✅ Models Loaded');

        checkServer();
        loadStudents(); // Start fetching students from API
        startCamera(video);
    } catch (err) {
        console.error('❌ Init Error:', err);
        document.querySelector('#loader p').innerText = "Error loading models. Check console.";
    }
}

// ─── CAMERA LOGIC ────────────────────────────────────────────────────────────

async function startCamera(targetVideo) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: "user" }
        });
        targetVideo.srcObject = stream;
    } catch (err) {
        console.error('❌ Camera Error:', err);
        alert("Camera access denied or not found.");
    }
}

// ─── API INTERACTION ─────────────────────────────────────────────────────────

async function checkServer() {
    try {
        const res = await fetch(API_BASE + '/');
        if (res.ok) {
            statusDot.classList.add('online');
            serverMsg.innerText = "API Connected (Railway)";
        }
    } catch (err) {
        serverMsg.innerText = "API Offline";
    }
}

async function loadStudents() {
    try {
        const res = await fetch(API_BASE + '/students');
        const students = await res.json();

        if (students.length === 0) {
            console.log('ℹ️ No students in DB yet');
            return;
        }

        // Build studentId → name map for display labels
        students.forEach(s => { studentNames[s.studentId] = s.name || s.studentId; });

        labeledFaceDescriptors = students
            .filter(s => s.faceDescriptor)
            .map(s => {
                return new faceapi.LabeledFaceDescriptors(
                    s.studentId,
                    [new Float32Array(s.faceDescriptor)]
                );
            });

        if (labeledFaceDescriptors.length > 0) {
            // Use CONFIDENCE_THRESHOLD — faces beyond this distance are flagged 'unknown'
            faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, CONFIDENCE_THRESHOLD);
            console.log(`✅ Loaded ${labeledFaceDescriptors.length} face signatures (threshold: ${CONFIDENCE_THRESHOLD})`);
        }
    } catch (err) {
        console.error('❌ Load Students Error:', err);
    }
}

// 📏 RESIZE OBSERVER: Automatically re-align canvases on screen change
function handleResize() {
    if (isScanMode) {
        syncCanvas(video, overlay);
    } else {
        syncCanvas(regVideo, regOverlay);
    }
}

function syncCanvas(vid, canv) {
    if (!vid || !canv || vid.offsetWidth === 0) return;
    const displaySize = { width: vid.offsetWidth, height: vid.offsetHeight };
    faceapi.matchDimensions(canv, displaySize);
}

window.addEventListener('resize', handleResize);

// ─── SCANNER LOOP ───────────────────────────────────────────────────────────

video.addEventListener('play', () => {
    syncCanvas(video, overlay);

    setInterval(async () => {
        if (!isScanMode || !isModelsLoaded || !faceMatcher) return;

        syncCanvas(video, overlay);
        const displaySize = { width: video.offsetWidth, height: video.offsetHeight };

        const detections = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptor();

        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (!detections) {
            // No face visible — reset frame to neutral
            setScanFrameState(null);
            return;
        }

        const resizedDetection = faceapi.resizeResults(detections, displaySize);
        const bestMatch = faceMatcher.findBestMatch(detections.descriptor);

        // ── DUAL VALIDATION: label check + explicit distance guard ──────────
        const isRecognized = bestMatch.label !== 'unknown' &&
                             bestMatch.distance <= CONFIDENCE_THRESHOLD;

        if (isRecognized) {
            // ✅ Confident match — draw GREEN box and mark attendance
            setScanFrameState('success');
            const displayName = studentNames[bestMatch.label] || bestMatch.label;
            new faceapi.draw.DrawBox(resizedDetection.detection.box, {
                label: `✓ ${displayName}`,
                boxColor: '#10b981',
                lineWidth: 3
            }).draw(overlay);
            handleSuccessMatch(bestMatch.label);
        } else {
            // ❌ Unknown / low-confidence — draw RED box, NO attendance recorded
            setScanFrameState('error');
            const dist = bestMatch.distance.toFixed(2);
            new faceapi.draw.DrawBox(resizedDetection.detection.box, {
                label: `✗ Unknown (dist: ${dist})`,
                boxColor: '#ef4444',
                lineWidth: 3
            }).draw(overlay);
            handleFailedMatch();
        }
    }, 1000);
});

let lastMatchedId = null;
let lastMatchTime = 0;
let lastFailTime = 0;

async function handleSuccessMatch(studentId) {
    const now = Date.now();
    if (studentId === lastMatchedId && (now - lastMatchTime < 5000)) return;

    lastMatchedId = studentId;
    lastMatchTime = now;

    try {
        const res = await fetch(API_BASE + '/scan-face', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId })
        });
        const data = await res.json();
        if (data.status === 'success') showToast(data.name);
    } catch (err) {
        console.error('❌ Attendance Error:', err);
    }
}

// Called when face is detected but does NOT meet confidence threshold.
// Has its own cooldown to avoid flooding the user with error messages.
function handleFailedMatch() {
    const now = Date.now();
    if (now - lastFailTime < FAIL_COOLDOWN_MS) return; // cooldown
    lastFailTime = now;
    console.warn('⚠️  Face detected but not recognized (below threshold)');
    showErrorToast();
}

// Update the animated scan-frame border: null | 'success' | 'error'
function setScanFrameState(state) {
    const frame = document.querySelector('.scan-frame');
    if (!frame) return;
    frame.classList.remove('success', 'error');
    if (scanFrameResetTimer) clearTimeout(scanFrameResetTimer);
    if (state) {
        frame.classList.add(state);
        // Auto-clear back to neutral after 2 s
        scanFrameResetTimer = setTimeout(() => {
            frame.classList.remove('success', 'error');
        }, 2000);
    }
}

function showToast(name) {
    const toast = document.getElementById('scan-result');
    document.getElementById('result-name').innerText = name;
    toast.classList.remove('hidden');
    // Hide error toast if success arrives
    document.getElementById('scan-error').classList.add('hidden');
    setTimeout(() => { toast.classList.add('hidden'); }, 4000);
}

function showErrorToast() {
    const toast = document.getElementById('scan-error');
    toast.classList.remove('hidden');
    // Trigger re-animation by removing and re-adding the class
    toast.classList.remove('toast-animate');
    void toast.offsetWidth; // reflow
    toast.classList.add('toast-animate');
    setTimeout(() => { toast.classList.add('hidden'); }, 3500);
}

// ─── REGISTRATION LOGIC ───────────────────────────────────────────────────────

regVideo.addEventListener('play', () => {
    syncCanvas(regVideo, regOverlay);

    setInterval(async () => {
        if (isScanMode || !isModelsLoaded) return;

        const displaySize = { width: regVideo.offsetWidth, height: regVideo.offsetHeight };

        const detection = await faceapi.detectSingleFace(regVideo, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptor();

        regOverlay.getContext('2d').clearRect(0, 0, regOverlay.width, regOverlay.height);
        if (detection) {
            currentDescriptor = Array.from(detection.descriptor);
            regStatus.innerText = "✅ Face Detected! Ready to save.";
            btnSave.disabled = false;

            // 🔴 Draw the Red Detection Box
            const resizedDetection = faceapi.resizeResults(detection, displaySize);
            const drawOptions = {
                label: 'Face Ready',
                boxColor: 'red',
                lineWidth: 2
            };
            const drawBox = new faceapi.draw.DrawBox(resizedDetection.detection.box, drawOptions);
            drawBox.draw(regOverlay);
        } else {
            currentDescriptor = null;
            regStatus.innerText = "Looking for face...";
            btnSave.disabled = true;
        }
    }, 1000);
});

btnSave.addEventListener('click', async () => {
    const name = document.getElementById('reg-name').value;
    const className = document.getElementById('reg-class').value;
    const nfcId = document.getElementById('reg-nfc').value;
    const password = document.getElementById('reg-pass').value;

    // 🔒 FRONTEND PASSWORD CHECK
    if (password !== ADMIN_PASS) {
        alert("❌ Incorrect Admin Password!");
        return;
    }

    if (!name || !nfcId || !currentDescriptor) {
        alert("Please fill all fields and look at the camera!");
        return;
    }

    btnSave.disabled = true;
    btnSave.innerText = "Saving...";

    try {
        const res = await fetch(API_BASE + '/students', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                className,
                nfcId,
                faceDescriptor: currentDescriptor
            })
        });

        if (res.ok) {
            alert("🎉 Student Registered Successfully!");
            document.getElementById('reg-name').value = '';
            document.getElementById('reg-nfc').value = '';
            document.getElementById('reg-pass').value = '';
            loadStudents();
        }
    } catch (err) {
        alert("Error saving to database.");
    } finally {
        btnSave.innerText = "💾 Save Student";
    }
});

// ─── NAV LOGIC ───────────────────────────────────────────────────────────────

navScan.addEventListener('click', () => {
    isScanMode = true;
    toggleNav(navScan, sectionScan);
    startCamera(video);
});

navRegister.addEventListener('click', () => {
    isScanMode = false;
    toggleNav(navRegister, sectionRegister);
    startCamera(regVideo);
});

function toggleNav(tab, section) {
    document.querySelectorAll('.nav-links li').forEach(li => li.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    tab.classList.add('active');
    section.classList.remove('hidden');
}

init();
