package web

import "embed"

//go:embed index.html app.js results.js style.css ping-worker.js
var FS embed.FS
