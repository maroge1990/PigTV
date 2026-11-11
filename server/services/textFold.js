'use strict';
/**
 * One fold for people's and teams' names (D-5, #222): lower case, accents stripped, and the letters that carry no combining
 * mark folded by hand ("Højgaard" ~ "Hojgaard", "Bodø/Glimt" ~ "Bodo/Glimt").
 * NOT for stored keys: sportsClassify.normText and channelLinks.nameKey feed hashed or saved keys and must not change.
 */
const FOLD = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

const foldText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[øæœßłđðþı]/g, c => FOLD[c]);

/** A person's name as follows compare it: no accents, case or punctuation ("Jiří Lehečka" is "jiri lehecka"). */
const personKey = (name) => foldText(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

module.exports = { foldText, personKey };
