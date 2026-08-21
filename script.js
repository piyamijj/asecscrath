(function () {
  "use strict";

  var CARD_SELECTOR_ROOT = document.getElementById("scratchCard");
  var canvas = document.getElementById("scratchCanvas");
  var hiddenImage = document.getElementById("hiddenImage");
  var frontImageSource = document.getElementById("frontImageSource");
  var hint = document.getElementById("hint");
  var caption = document.getElementById("caption");
  var revealFlourish = document.getElementById("revealFlourish");
  var voilaAudio = document.getElementById("voilaAudio");

  var ctx = canvas.getContext("2d");
  var defaultAudioVolume = voilaAudio ? voilaAudio.volume : 1;

  var BRUSH_RADIUS = 20; // soft brush radius in CSS px (smaller = needs real, sustained scratching)
  var REVEAL_THRESHOLD = 0.50; // 50% scratched triggers payoff
  var CENTER_HIT_RADIUS_RATIO = 0.05; // fraction of canvas min-dimension: a small, deliberate bullseye on the emblem's center - not a broad "anywhere in the middle" zone
  var SAMPLE_STEP = 4; // sample every Nth pixel when estimating scratched percentage (perf)
  var PERCENT_CHECK_EVERY_N_MOVES = 3; // throttle getImageData cost without leaving the gesture's call stack

  var dpr = Math.max(1, window.devicePixelRatio || 1);
  var cssWidth = 0;
  var cssHeight = 0;
  var isDrawing = false;
  var hasInteracted = false;
  var isRevealed = false;
  var audioUnlocked = false;
  var audioPlaybackPending = false;
  var realPlaybackTriggered = false;
  var lastPoint = null;
  var frontImageReady = false;
  var hiddenImageReady = false;
  var moveEventCount = 0;

  function onFrontImageLoaded() {
    frontImageReady = true;
    maybeInit();
  }

  function onHiddenImageLoaded() {
    hiddenImageReady = true;
    maybeInit();
  }

  if (frontImageSource.complete && frontImageSource.naturalWidth > 0) {
    frontImageReady = true;
  } else {
    frontImageSource.addEventListener("load", onFrontImageLoaded);
  }

  if (hiddenImage.complete && hiddenImage.naturalWidth > 0) {
    hiddenImageReady = true;
  } else {
    hiddenImage.addEventListener("load", onHiddenImageLoaded);
  }

  function maybeInit() {
    if (frontImageReady && hiddenImageReady && !initialized) {
      initialized = true;
      setupCanvas();
      drawFrontLayer();
      attachEvents();
    }
  }

  var initialized = false;

  function setupCanvas() {
    var rect = CARD_SELECTOR_ROOT.getBoundingClientRect();
    cssWidth = Math.max(1, Math.round(rect.width));
    cssHeight = Math.max(1, Math.round(rect.height));
    dpr = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawFrontLayer() {
    if (isRevealed) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    drawCoverImage(ctx, frontImageSource, cssWidth, cssHeight);
  }

  // Draws an image into the canvas using "object-fit: cover" style scaling/cropping,
  // so it matches how the hidden image is rendered underneath.
  function drawCoverImage(context, img, targetW, targetH) {
    var naturalW = img.naturalWidth || img.width;
    var naturalH = img.naturalHeight || img.height;
    if (!naturalW || !naturalH) return;

    var targetRatio = targetW / targetH;
    var naturalRatio = naturalW / naturalH;

    var sx, sy, sWidth, sHeight;

    if (naturalRatio > targetRatio) {
      // source is wider than target: crop left/right
      sHeight = naturalH;
      sWidth = naturalH * targetRatio;
      sy = 0;
      sx = (naturalW - sWidth) / 2;
    } else {
      // source is taller than target: crop top/bottom
      sWidth = naturalW;
      sHeight = naturalW / targetRatio;
      sx = 0;
      sy = (naturalH - sHeight) / 2;
    }

    context.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, targetW, targetH);
  }

  function getPointFromEvent(evt) {
    var rect = canvas.getBoundingClientRect();
    var clientX, clientY;

    if (evt.touches && evt.touches.length > 0) {
      clientX = evt.touches[0].clientX;
      clientY = evt.touches[0].clientY;
    } else if (evt.changedTouches && evt.changedTouches.length > 0) {
      clientX = evt.changedTouches[0].clientX;
      clientY = evt.changedTouches[0].clientY;
    } else {
      clientX = evt.clientX;
      clientY = evt.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function scratchAt(x, y) {
    ctx.globalCompositeOperation = "destination-out";

    var gradient = ctx.createRadialGradient(x, y, 0, x, y, BRUSH_RADIUS);
    gradient.addColorStop(0, "rgba(0,0,0,1)");
    gradient.addColorStop(0.65, "rgba(0,0,0,0.9)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, BRUSH_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    checkCenterHit(x, y);
  }

  function scratchLine(from, to) {
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var distance = Math.sqrt(dx * dx + dy * dy);
    var step = Math.max(2, BRUSH_RADIUS / 4);
    var steps = Math.max(1, Math.ceil(distance / step));

    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var x = from.x + dx * t;
      var y = from.y + dy * t;
      scratchAt(x, y);
    }
  }

  function checkCenterHit(x, y) {
    if (isRevealed) return;
    var centerX = cssWidth / 2;
    var centerY = cssHeight / 2;
    var minDim = Math.min(cssWidth, cssHeight);
    var hitRadius = minDim * CENTER_HIT_RADIUS_RATIO;

    var dx = x - centerX;
    var dy = y - centerY;
    var dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= hitRadius) {
      triggerReveal();
    }
  }

  // Runs the (relatively costly) getImageData scan synchronously, in the
  // SAME call stack as the mouse/touch event that triggered it. This is
  // deliberate: deferring this via requestAnimationFrame/setTimeout would
  // detach triggerReveal() (and its audio.play() call) from the user
  // gesture, which browsers use to decide whether audio is allowed to play.
  // We only throttle by event count, never by async deferral.
  function scheduleScratchedPercentCheck(force) {
    if (isRevealed) return;
    if (!force) {
      moveEventCount++;
      if (moveEventCount % PERCENT_CHECK_EVERY_N_MOVES !== 0) return;
    }
    var percent = estimateScratchedPercent();
    if (percent >= REVEAL_THRESHOLD) {
      triggerReveal();
    }
  }

  function estimateScratchedPercent() {
    var w = canvas.width;
    var h = canvas.height;
    if (w === 0 || h === 0) return 0;

    var imageData;
    try {
      imageData = ctx.getImageData(0, 0, w, h).data;
    } catch (err) {
      return 0;
    }

    var totalSampled = 0;
    var transparentCount = 0;

    for (var py = 0; py < h; py += SAMPLE_STEP) {
      for (var px = 0; px < w; px += SAMPLE_STEP) {
        var idx = (py * w + px) * 4 + 3; // alpha channel
        totalSampled++;
        if (imageData[idx] < 32) {
          transparentCount++;
        }
      }
    }

    if (totalSampled === 0) return 0;
    return transparentCount / totalSampled;
  }

  // "Primes" the audio element with a real, synchronous user gesture
  // (mousedown/touchstart). Some browsers (notably mobile Safari) only ever
  // allow an <audio> element to play if IT has previously been played, even
  // briefly, directly inside a trusted gesture handler; once that happens,
  // later play() calls on the same element succeed even if triggered from
  // a non-gesture context (e.g. mid-drag, once a threshold is crossed).
  function unlockAudio() {
    if (audioUnlocked || !voilaAudio) return;
    audioUnlocked = true;
    try {
      voilaAudio.volume = 0;
      var primePromise = voilaAudio.play();
      if (primePromise && typeof primePromise.then === "function") {
        primePromise.then(function () {
          // If the real payoff sound already started (synchronously, later
          // in the same gesture) while this promise was pending, leave it
          // alone - do NOT pause/rewind/re-mute audio that is genuinely
          // playing for the user right now.
          if (realPlaybackTriggered) return;
          voilaAudio.pause();
          voilaAudio.currentTime = 0;
          voilaAudio.volume = defaultAudioVolume;
        }).catch(function () {
          // Some browsers reject a play() that is immediately paused; that's
          // fine, the gesture attempt itself is what matters for unlocking.
          if (!realPlaybackTriggered) voilaAudio.volume = defaultAudioVolume;
        });
      } else {
        voilaAudio.pause();
        voilaAudio.currentTime = 0;
        voilaAudio.volume = defaultAudioVolume;
      }
    } catch (err) {
      /* Audio not available; the real playAudioPayoff() call will just fail silently later. */
    }
  }

  function playAudioPayoff() {
    if (!voilaAudio) return;
    // Mark this BEFORE calling play(), synchronously, so that if an
    // in-flight unlockAudio() promise resolves right after this, it knows
    // real playback has already taken over and must not touch the element.
    realPlaybackTriggered = true;
    voilaAudio.volume = defaultAudioVolume;
    try {
      voilaAudio.currentTime = 0;
      var playPromise = voilaAudio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(function () {
          // First attempt was blocked (e.g. unlock hadn't resolved yet on a
          // very fast tap-and-release). Retry once on the next real gesture
          // anywhere on the page, which will definitely be trusted.
          if (audioPlaybackPending) return;
          audioPlaybackPending = true;
          var retry = function () {
            document.removeEventListener("pointerdown", retry, true);
            document.removeEventListener("touchend", retry, true);
            var retryPromise = voilaAudio.play();
            if (retryPromise && typeof retryPromise.catch === "function") {
              retryPromise.catch(function () { /* give up quietly */ });
            }
          };
          document.addEventListener("pointerdown", retry, true);
          document.addEventListener("touchend", retry, true);
        });
      }
    } catch (err) {
      /* Audio not available; ignore. */
    }
  }

  function triggerReveal() {
    if (isRevealed) return;
    isRevealed = true;

    hideHint();
    playAudioPayoff();

    CARD_SELECTOR_ROOT.classList.add("is-revealed");
    revealFlourish.classList.add("is-active");
    if (caption) {
      caption.textContent = "Voil\u00e0. Red John was here all along.";
      caption.classList.add("is-revealed");
    }

    // Smoothly finish clearing whatever overlay remains so the whole
    // hidden image is visible, matching the CSS fade-out on the canvas.
    window.setTimeout(function () {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.fillRect(0, 0, cssWidth, cssHeight);
    }, 550);
  }

  function hideHint() {
    if (hint && !hint.classList.contains("is-hidden")) {
      hint.classList.add("is-hidden");
    }
  }

  function handleStart(evt) {
    if (isRevealed) return;
    evt.preventDefault();
    // Prime/unlock the audio element synchronously inside this real user
    // gesture (mousedown/touchstart), before any scratching happens. This
    // is what lets the LATER triggerReveal() play the sound successfully,
    // even a delayed reveal deep into a drag.
    unlockAudio();
    isDrawing = true;
    hasInteracted = true;
    hideHint();
    var point = getPointFromEvent(evt);
    lastPoint = point;
    scratchAt(point.x, point.y);
    scheduleScratchedPercentCheck(true);
  }

  function handleMove(evt) {
    if (!isDrawing || isRevealed) return;
    evt.preventDefault();
    var point = getPointFromEvent(evt);
    if (lastPoint) {
      scratchLine(lastPoint, point);
    } else {
      scratchAt(point.x, point.y);
    }
    lastPoint = point;
    scheduleScratchedPercentCheck(false);
  }

  function handleEnd(evt) {
    if (!isDrawing) return;
    isDrawing = false;
    lastPoint = null;
    scheduleScratchedPercentCheck(true);
  }

  function attachEvents() {
    // Mouse events
    canvas.addEventListener("mousedown", handleStart);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleEnd);

    // Touch events
    canvas.addEventListener("touchstart", handleStart, { passive: false });
    canvas.addEventListener("touchmove", handleMove, { passive: false });
    canvas.addEventListener("touchend", handleEnd, { passive: false });
    canvas.addEventListener("touchcancel", handleEnd, { passive: false });

    window.addEventListener("resize", handleResize);
  }

  var resizeTimer = null;
  function handleResize() {
    if (isRevealed) return; // don't disturb an already-revealed card
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      setupCanvas();
      drawFrontLayer();
    }, 150);
  }

  // Kick things off once the DOM and images are ready.
  if (document.readyState === "complete" || document.readyState === "interactive") {
    maybeInit();
  } else {
    document.addEventListener("DOMContentLoaded", maybeInit);
  }
})();