'use strict';

/**
 * #265: a channel's picture quality, read from its name: the one rule behind every label a client sees (C-I sport
 * channels, C-X guide and channel rows) and behind the backup linker's quality classes (channelLinks.qualityOf).
 *
 * The name is folded first (NFKD, accents gone, lower case), so the superscript tags providers use ("ᵁᴴᴰ", "ᴴᴰ", "ᴿᴬᵂ")
 * read as letters. Before #265 the sport rule did not fold, so "SKY SPORTS F1 ᵁᴴᴰ" had no label, and it counted FHD as HD.
 *
 *   UHD: uhd, 4k, 8k, 2160p…, 3840…, hdr
 *   FHD: fhd, 1080p/i…
 *   HD:  hd, 720p…, hevc
 *   SD:  sd, 576/540/480/360p…
 *   null: none of them ("Sky Sports Main Event", "HDTV")
 *
 * The highest tag wins ("F1 UHD/HD" is UHD). Nothing here measures a stream: a name can be wrong.
 */

function fold(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const RULES = [
    ['UHD', /\b(?:uhd|4k|8k|2160[pi]?\d*|3840[pi]?\d*|hdr)\b/],
    ['FHD', /\b(?:fhd|1080[pi]?\d*)\b/],
    ['HD', /\b(?:hd|720[pi]?\d*|hevc)\b/],
    ['SD', /\b(?:sd|576[pi]?\d*|540[pi]?\d*|480[pi]?\d*|360[pi]?\d*)\b/]
];

/** 'UHD' | 'FHD' | 'HD' | 'SD' | null, from the channel's name. */
function qualityLabel(name) {
    const s = fold(name);
    for (const [label, re] of RULES) if (re.test(s)) return label;
    return null;
}

/** Best first: UHD, FHD, HD, then a name with no tag (usually HD, never known), then SD. */
const RANK = { UHD: 0, FHD: 1, HD: 2, SD: 4 };
const qualityRank = (label) => RANK[label] ?? 3;

module.exports = { qualityLabel, qualityRank, fold };
