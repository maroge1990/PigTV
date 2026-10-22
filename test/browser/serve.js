// W2 (0239): a real-browser check of keyboard focus across guide/list redraws, which node's test
// runner (no DOM) cannot make. Run `node test/browser/serve.js`, open
// http://127.0.0.1:4377/focus-harness.html, and read window.results (also printed on the page):
// every entry should name the same channel/programme as "before" (afterChannelGone: the next row).
const http = require('http'), fs = require('fs'), path = require('path');
const pub = path.join(__dirname, '../../public');
http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const file = u === '/focus-harness.html' ? path.join(__dirname, 'focus-harness.html') : path.join(pub, u);
    if (u !== '/focus-harness.html' && !file.startsWith(pub)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store' });
        res.end(data);
    });
}).listen(4377, '127.0.0.1', () => console.log('http://127.0.0.1:4377/focus-harness.html'));
