(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  var EAR_THRESHOLD = 0.18;
  var BLINK_FRAMES = 1;
  var REQUIRED_BLINKS = 2;
  var HEAD_TURN_THRESHOLD = 0.08;
  var HEAD_TURN_HOLD_MS = 400;
  var CHALLENGE_TIMEOUT_MS = 20000;
  var MIN_TOTAL_DURATION_MS = 3000;

  // ── URL params ──────────────────────────────────────────────────────────────
  var params = new URLSearchParams(window.location.search);
  var authToken = params.get('token');
  var apiBase = params.get('apiBase') || '';

  // ── DOM ─────────────────────────────────────────────────────────────────────
  var video = document.getElementById('video');
  var overlay = document.getElementById('overlay');
  var captureCanvas = document.getElementById('capture-canvas');
  var challengeText = document.getElementById('challenge-text');
  var faceGuide = document.querySelector('.face-guide');
  var retryBtn = document.getElementById('retry-btn');
  var dots = [
    document.getElementById('dot-0'),
    document.getElementById('dot-1'),
    document.getElementById('dot-2'),
  ];

  // ── State ───────────────────────────────────────────────────────────────────
  var detector = null;
  var stream = null;
  var running = false;
  var startedAt = 0;
  var challengeResults = {
    blinksDetected: 0,
    headTurnLeft: false,
    headTurnRight: false,
    durationMs: 0,
    framesAnalyzed: 0,
  };

  // Blink detection state
  var blinkState = 'OPEN'; // OPEN | CLOSING | CLOSED
  var lowEarFrames = 0;
  var blinkCount = 0;

  // Head turn state
  var turnStartTime = 0;

  // ── Screens ─────────────────────────────────────────────────────────────────
  function showScreen(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.remove('active');
    }
    document.getElementById(id).classList.add('active');
  }

  // ── Camera ──────────────────────────────────────────────────────────────────
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      console.error('Camera error:', err);
      showScreen('denied-screen');
      throw err;
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  // ── Model ───────────────────────────────────────────────────────────────────
  async function loadModel() {
    await tf.setBackend('webgl');
    await tf.ready();

    var model = faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh;
    detector = await faceLandmarksDetection.createDetector(model, {
      runtime: 'tfjs',
      refineLandmarks: true,
      maxFaces: 1,
    });
  }

  // ── Eye Aspect Ratio ────────────────────────────────────────────────────────
  // MediaPipe FaceMesh eye landmark indices (refined):
  // Right eye: 33, 160, 158, 133, 153, 144
  // Left eye: 362, 385, 387, 263, 373, 380
  function eyeAspectRatio(landmarks, eyeIndices) {
    var p1 = landmarks[eyeIndices[0]];
    var p2 = landmarks[eyeIndices[1]];
    var p3 = landmarks[eyeIndices[2]];
    var p4 = landmarks[eyeIndices[3]];
    var p5 = landmarks[eyeIndices[4]];
    var p6 = landmarks[eyeIndices[5]];

    var vertical1 = dist(p2, p6);
    var vertical2 = dist(p3, p5);
    var horizontal = dist(p1, p4);

    if (horizontal === 0) return 1;
    return (vertical1 + vertical2) / (2 * horizontal);
  }

  function dist(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // MediaPipe FaceMesh refined eye landmark indices
  var RIGHT_EYE = [33, 160, 158, 133, 153, 144];
  var LEFT_EYE = [362, 385, 387, 263, 373, 380];

  // Adaptive baseline for EAR — calibrates to user's open-eye EAR
  var earBaseline = 0;
  var earSamples = [];
  var EAR_CALIBRATION_FRAMES = 8;

  function calibrateEar(ear) {
    if (earSamples.length < EAR_CALIBRATION_FRAMES) {
      earSamples.push(ear);
      if (earSamples.length === EAR_CALIBRATION_FRAMES) {
        earBaseline = earSamples.reduce(function (s, v) { return s + v; }, 0) / earSamples.length;
      }
      return false; // Still calibrating
    }
    return true;
  }

  function detectBlink(landmarks) {
    var leftEar = eyeAspectRatio(landmarks, LEFT_EYE);
    var rightEar = eyeAspectRatio(landmarks, RIGHT_EYE);
    var ear = (leftEar + rightEar) / 2;

    // Use adaptive threshold: 70% of open-eye baseline, or fixed threshold if not calibrated
    var threshold = earBaseline > 0 ? earBaseline * 0.7 : EAR_THRESHOLD;
    if (!calibrateEar(ear)) return blinkCount;

    if (ear < threshold) {
      lowEarFrames++;
      if (lowEarFrames >= BLINK_FRAMES && blinkState === 'OPEN') {
        blinkState = 'CLOSED';
      }
    } else {
      if (blinkState === 'CLOSED') {
        blinkCount++;
        blinkState = 'OPEN';
      }
      lowEarFrames = 0;
      if (blinkState !== 'CLOSED') {
        blinkState = 'OPEN';
      }
    }

    return blinkCount;
  }

  // ── Head Turn Detection ─────────────────────────────────────────────────────
  // Nose tip = landmark 1, left face edge ~234, right face edge ~454
  function detectHeadTurn(landmarks, direction) {
    var noseTip = landmarks[1];
    var leftEdge = landmarks[234];
    var rightEdge = landmarks[454];

    var faceWidth = Math.abs(rightEdge.x - leftEdge.x);
    if (faceWidth === 0) return false;

    var faceCenter = (leftEdge.x + rightEdge.x) / 2;
    var noseOffset = (noseTip.x - faceCenter) / faceWidth;

    if (direction === 'left') {
      return noseOffset > HEAD_TURN_THRESHOLD;
    }
    return noseOffset < -HEAD_TURN_THRESHOLD;
  }

  // ── Challenge Runner ────────────────────────────────────────────────────────
  var challenges = ['blink', 'turnLeft', 'turnRight'];

  function shuffleChallenges() {
    for (var i = challenges.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = challenges[i];
      challenges[i] = challenges[j];
      challenges[j] = tmp;
    }
  }

  async function runChallenges() {
    shuffleChallenges();
    startedAt = Date.now();
    running = true;

    for (var i = 0; i < challenges.length; i++) {
      dots[i].className = 'dot active';
      var success = await runSingleChallenge(challenges[i], i);
      if (!success) {
        running = false;
        showError('Challenge timed out. Please try again.');
        return false;
      }
      dots[i].className = 'dot done';
      faceGuide.className = 'face-guide challenge-done';
      await sleep(300);
    }

    challengeResults.durationMs = Date.now() - startedAt;
    running = false;
    return true;
  }

  async function runSingleChallenge(type, dotIndex) {
    faceGuide.className = 'face-guide challenge-active';
    turnStartTime = 0;

    if (type === 'blink') {
      blinkCount = 0;
      blinkState = 'OPEN';
      lowEarFrames = 0;
      challengeText.textContent = 'Blink your eyes twice';
    } else if (type === 'turnLeft') {
      challengeText.textContent = 'Turn your head to the left';
    } else {
      challengeText.textContent = 'Turn your head to the right';
    }

    var deadline = Date.now() + CHALLENGE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      var faces = await detector.estimateFaces(video);
      challengeResults.framesAnalyzed++;

      if (!faces || faces.length === 0) {
        await sleep(50);
        continue;
      }

      var keypoints = faces[0].keypoints;

      if (type === 'blink') {
        var blinks = detectBlink(keypoints);
        challengeText.textContent = 'Blink your eyes twice (' + blinks + '/' + REQUIRED_BLINKS + ')';
        if (blinks >= REQUIRED_BLINKS) {
          challengeResults.blinksDetected = blinks;
          return true;
        }
      } else {
        var direction = type === 'turnLeft' ? 'left' : 'right';
        var turned = detectHeadTurn(keypoints, direction);

        if (turned) {
          if (turnStartTime === 0) turnStartTime = Date.now();
          if (Date.now() - turnStartTime >= HEAD_TURN_HOLD_MS) {
            if (direction === 'left') challengeResults.headTurnLeft = true;
            else challengeResults.headTurnRight = true;
            return true;
          }
        } else {
          turnStartTime = 0;
        }
      }

      await sleep(33); // ~30fps
    }

    return false; // Timed out
  }

  // ── Capture Selfie ──────────────────────────────────────────────────────────
  function captureSelfie() {
    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;
    var ctx = captureCanvas.getContext('2d');
    // Mirror the image to match what the user saw
    ctx.translate(captureCanvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    return captureCanvas.toDataURL('image/jpeg', 0.85);
  }

  // ── Submit to Backend ───────────────────────────────────────────────────────
  async function submitVerification(selfieData) {
    var url = apiBase + '/kyc/verify';
    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      body: JSON.stringify({
        selfieData: selfieData,
        challengeResults: challengeResults,
      }),
    });

    if (!response.ok) {
      var body = await response.json().catch(function () { return {}; });
      throw new Error(body.error || 'Verification failed');
    }

    return response.json();
  }

  // ── Notify App ──────────────────────────────────────────────────────────────
  function notifyApp(result) {
    var message = JSON.stringify({
      type: 'kyc:verified',
      verifiedAt: result.verifiedAt,
    });

    // React Native WebView
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(message);
    }
    // Fallback: standard postMessage
    if (window.parent !== window) {
      window.parent.postMessage(message, '*');
    }
  }

  // ── Error Handling ──────────────────────────────────────────────────────────
  function showError(msg) {
    document.getElementById('error-message').textContent = msg;
    showScreen('error-screen');
    stopCamera();
  }

  // ── Utils ───────────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ── Main Flow ───────────────────────────────────────────────────────────────
  async function run() {
    if (!authToken) {
      showError('Missing authentication token.');
      return;
    }

    showScreen('loading-screen');

    try {
      await startCamera();
      await loadModel();
    } catch (err) {
      if (!stream) return; // Camera denied — already showing denied screen
      showError('Could not initialize face detection: ' + err.message);
      return;
    }

    showScreen('camera-screen');

    // Wait for face to be detected and calibrate EAR baseline
    challengeText.textContent = 'Position your face in the circle';
    var faceFound = false;
    var stableFaceFrames = 0;
    var faceAttempts = 0;
    earSamples = [];
    earBaseline = 0;
    while (stableFaceFrames < 10 && faceAttempts < 450) { // ~15 seconds
      var faces = await detector.estimateFaces(video);
      if (faces && faces.length > 0) {
        if (!faceFound) {
          faceFound = true;
          faceGuide.className = 'face-guide detected';
          challengeText.textContent = 'Hold steady...';
        }
        stableFaceFrames++;

        // Calibrate EAR during stable detection
        var kp = faces[0].keypoints;
        var le = eyeAspectRatio(kp, LEFT_EYE);
        var re = eyeAspectRatio(kp, RIGHT_EYE);
        calibrateEar((le + re) / 2);
      } else {
        stableFaceFrames = 0;
        if (faceFound) {
          faceGuide.className = 'face-guide';
          challengeText.textContent = 'Position your face in the circle';
          faceFound = false;
        }
      }
      faceAttempts++;
      await sleep(33);
    }

    if (stableFaceFrames < 10) {
      showError('No face detected. Please ensure your face is visible and well-lit.');
      return;
    }

    await sleep(400);

    // Run liveness challenges
    var passed = await runChallenges();
    if (!passed) return;

    // Capture selfie
    challengeText.textContent = 'Capturing...';
    await sleep(200);
    var selfieData = captureSelfie();
    stopCamera();

    // Submit
    showScreen('submitting-screen');

    try {
      var result = await submitVerification(selfieData);
      showScreen('success-screen');
      notifyApp(result);
    } catch (err) {
      showError(err.message);
    }
  }

  // ── Retry ───────────────────────────────────────────────────────────────────
  retryBtn.addEventListener('click', function () {
    // Reset state
    challengeResults = {
      blinksDetected: 0,
      headTurnLeft: false,
      headTurnRight: false,
      durationMs: 0,
      framesAnalyzed: 0,
    };
    blinkCount = 0;
    blinkState = 'OPEN';
    lowEarFrames = 0;
    turnStartTime = 0;
    earBaseline = 0;
    earSamples = [];

    for (var i = 0; i < dots.length; i++) {
      dots[i].className = 'dot';
    }
    faceGuide.className = 'face-guide';

    run();
  });

  // ── Start ───────────────────────────────────────────────────────────────────
  run();
})();
