// stars.js - background starfield: slowly falling stars + the occasional shooting star.
// Purely decorative; it has nothing to do with Adobe. Turns itself off for "reduce motion" users.

(function () {
  var canvas = document.getElementById("starfield");
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext("2d");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);   // sharp on retina, capped for performance
  var TINTS = ["#ffffff", "#ffffff", "#ffffff", "#cfe9ff", "#ffd9b0"];  // mostly white, some blue/amber
  var width = 0, height = 0, stars = [], meteors = [];

  function makeStar(y) {
    var depth = Math.random();                 // 0 = far away, 1 = close
    return {
      x: Math.random() * width,
      y: y,
      r: 0.3 + depth * 1.3,                    // closer stars are bigger...
      speed: 0.04 + depth * 0.32,              // ...and fall faster (parallax)
      tint: TINTS[Math.floor(Math.random() * TINTS.length)],
      phase: Math.random() * Math.PI * 2       // so they don't all twinkle in sync
    };
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var count = Math.round((width * height) / 5000);
    stars = [];
    for (var i = 0; i < count; i++) stars.push(makeStar(Math.random() * height));
    if (reduceMotion) draw(0);                 // static sky: draw once
  }

  function spawnMeteor() {
    meteors.push({
      x: width * (0.25 + Math.random() * 0.85),
      y: -20,
      vx: -(3.5 + Math.random() * 3),          // streak down and to the left
      vy: 4.5 + Math.random() * 3,
      life: 1
    });
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);

    // Falling, twinkling stars
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      if (!reduceMotion) {
        s.y += s.speed;
        if (s.y > height + 2) { s.y = -2; s.x = Math.random() * width; }
      }
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(time / 900 + s.phase);
      ctx.fillStyle = s.tint;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Shooting stars
    if (!reduceMotion && Math.random() < 0.007) spawnMeteor();
    for (var j = meteors.length - 1; j >= 0; j--) {
      var m = meteors[j];
      m.x += m.vx; m.y += m.vy; m.life -= 0.011;
      if (m.life <= 0 || m.y > height + 40 || m.x < -200) { meteors.splice(j, 1); continue; }

      var tailX = m.x - m.vx * 16, tailY = m.y - m.vy * 16;
      var trail = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
      trail.addColorStop(0, "rgba(255, 236, 214, " + m.life + ")");
      trail.addColorStop(0.3, "rgba(255, 155, 61, " + (m.life * 0.5) + ")");
      trail.addColorStop(1, "rgba(255, 155, 61, 0)");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = trail;
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    if (!reduceMotion) window.requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  resize();
  if (!reduceMotion) window.requestAnimationFrame(draw);
})();