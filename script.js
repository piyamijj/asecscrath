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

  var BRUSH_RADIUS = 30; // soft brush radius in CSS px (~25-35px per spec)
  var REVEAL_THRESHOLD = 0.55; // 55% scratched triggers payoff
  var CENTER_HIT_RADIUS_RATIO = 0.16; // fraction of canvas min-dimension counted as "center emblem"
  var SAMPLE_STEP = 4; // sample every Nth pixel when estimating scratched percentage (perf)

  var dpr = Math.max(1, window.devicePixelRatio || 1);
  var cssWidth = 0;
  var cssHeight = 0;
  var isDrawing = false;
  var hasInteracted = false;
  var isRevealed = false;
  var lastPoint = null;
  var frontImageReady = false;
  var hiddenImageReady = false;
  var pendingPercentCheck = false;

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

  function scheduleScratchedPercentCheck() {
    if (pendingPercentCheck || isRevealed) return;
    pendingPercentCheck = true;
    window.requestAnimationFrame(function () {
      pendingPercentCheck = false;
      var percent = estimateScratchedPercent();
      if (percent >= REVEAL_THRESHOLD) {
        triggerReveal();
      }
    });
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

  function triggerReveal() {
    if (isRevealed) return;
    isRevealed = true;

    hideHint();

    // Play the payoff sound. Browsers may block autoplay-with-sound until a
    // user gesture has occurred; scratching the card already counts as one.
    try {
      voilaAudio.currentTime = 0;
      var playPromise = voilaAudio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(function () {
          /* Playback blocked; silently ignore. */
        });
      }
    } catch (err) {
      /* Audio not available; ignore. */
    }

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
    isDrawing = true;
    hasInteracted = true;
    hideHint();
    var point = getPointFromEvent(evt);
    lastPoint = point;
    scratchAt(point.x, point.y);
    scheduleScratchedPercentCheck();
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
    scheduleScratchedPercentCheck();
  }

  function handleEnd(evt) {
    if (!isDrawing) return;
    isDrawing = false;
    lastPoint = null;
    scheduleScratchedPercentCheck();
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