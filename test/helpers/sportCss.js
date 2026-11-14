// #326: sport.css read as rules, for the tests that hold the web Sport cards to the iOS look.
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'sport.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declarations of every rule whose selector list names `selector` exactly, joined. Top-level rules only, unless
 * `media` is given: then only rules inside an @media whose condition contains it.
 */
function rulesFor(selector, { media = null } = {}) {
    const out = [];
    const walk = (text, inMedia) => {
        let i = 0;
        while (i < text.length) {
            const open = text.indexOf('{', i);
            if (open < 0) break;
            const head = text.slice(i, open).trim();
            let depth = 1, j = open + 1;
            while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
            const body = text.slice(open + 1, j - 1);
            if (head.startsWith('@')) walk(body, head);
            else if ((media ? inMedia && inMedia.includes(media) : !inMedia) && head.split(',').map(s => s.trim()).includes(selector)) out.push(body);
            i = j;
        }
    };
    walk(css, null);
    return out.join(';');
}

module.exports = { css, rulesFor };
