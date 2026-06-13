// Runs once at module import time, before React mounts.
// cv.js must load before aruco.js — order matters.

function seq(urls, i) {
  if (i >= urls.length) return;
  const s = document.createElement("script");
  s.src = urls[i];
  s.onload = () => seq(urls, i + 1);
  document.head.appendChild(s);
}

if (!window.__arucoLoading) {
  window.__arucoLoading = true;
  seq([
    "https://unpkg.com/js-aruco2@2.0.0/src/cv.js",
    "https://unpkg.com/js-aruco2@2.0.0/src/svd.js",
    "https://unpkg.com/js-aruco2@2.0.0/src/aruco.js",
    "https://docs.opencv.org/4.8.0/opencv.js",   // only needed for solvePnP
  ], 0);
}