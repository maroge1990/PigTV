const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #64: every signed-in request the web app makes goes through API.authFetch (public/js/api.js). A test that runs a page
// script in a vm context gives it the real one, compiled in that context so it uses the context's fetch and
// localStorage. A context with no API gets the whole real api.js; a test's own API stub keeps its other members and
// gains the real authFetch.
const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8');

function loadApi(context) {
    const real = vm.runInContext(`(() => { const window = {};\n${SOURCE}\nreturn API; })()`, context);
    if (context.API) context.API.authFetch = real.authFetch;
    else context.API = real;
    return context;
}

module.exports = { loadApi };
