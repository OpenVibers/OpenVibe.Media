'use strict';
// Paste storage plumbing, shared by the public screenshot route and the avatar ingest
// (which stores every avatar as an unlisted screenshot paste): where a paste's
// screenshot bytes land and how a slug is minted (checked against the pastes table,
// so two writes never get the same one). A leaf module — requiring it pulls in
// neither a router nor anything that mounts one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');
const drill = require('../drill');

const SCREENSHOTS_DIR = path.join(config.pastes.path, 'screenshots');
if (!drill.enabled && !fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });   // a restore drill writes nothing

// Word pools for readable paste slugs (adj-noun-number)
const SLUG_ADJECTIVES = [
    'amber', 'blue', 'bold', 'brave', 'bright', 'calm', 'clean', 'clever',
    'cold', 'cool', 'coral', 'crisp', 'dark', 'dawn', 'deep', 'dry',
    'dusk', 'dusty', 'fair', 'fast', 'fierce', 'fine', 'foggy', 'free',
    'fresh', 'frost', 'glad', 'gold', 'grand', 'gray', 'green', 'grim',
    'hazy', 'heavy', 'hidden', 'hollow', 'honey', 'hot', 'icy', 'iron',
    'jade', 'keen', 'kind', 'late', 'lazy', 'light', 'lime', 'lit',
    'lone', 'lost', 'loud', 'lucky', 'lush', 'mild', 'misty', 'mossy',
    'muddy', 'neon', 'new', 'noble', 'odd', 'old', 'opal', 'open',
    'pale', 'pink', 'plain', 'plum', 'prime', 'proud', 'pure', 'quick',
    'quiet', 'rare', 'raw', 'red', 'rich', 'rocky', 'rosy', 'rough',
    'ruby', 'rusty', 'safe', 'sage', 'sandy', 'sharp', 'shy', 'silver',
    'slim', 'slow', 'smoky', 'snowy', 'soft', 'sour', 'steep', 'still',
    'stone', 'sunny', 'sweet', 'swift', 'tall', 'tame', 'teal', 'thin',
    'tidy', 'tiny', 'torn', 'vast', 'vivid', 'warm', 'wavy', 'west',
    'wet', 'white', 'wide', 'wild', 'windy', 'wise', 'worn', 'young',
];
const SLUG_NOUNS = [
    'acorn', 'arch', 'arrow', 'aspen', 'badger', 'basil', 'bay', 'bear',
    'birch', 'blade', 'bloom', 'bolt', 'brook', 'brush', 'cairn', 'cave',
    'cedar', 'cliff', 'cloud', 'clover', 'coast', 'coral', 'crane', 'creek',
    'crow', 'dale', 'deer', 'delta', 'dew', 'dock', 'dove', 'drift',
    'drum', 'dune', 'eagle', 'echo', 'edge', 'elm', 'ember', 'fawn',
    'fern', 'field', 'finch', 'flame', 'flare', 'flint', 'fog', 'ford',
    'forge', 'fox', 'frost', 'gale', 'gate', 'gem', 'glen', 'goat',
    'grove', 'gull', 'hawk', 'haze', 'heath', 'hedge', 'heron', 'hill',
    'holly', 'horse', 'hound', 'isle', 'ivy', 'jade', 'jay', 'kelp',
    'lake', 'lark', 'leaf', 'ledge', 'lily', 'lion', 'lodge', 'lynx',
    'maple', 'marsh', 'mesa', 'mill', 'mint', 'mist', 'moon', 'moss',
    'moth', 'mule', 'nest', 'oak', 'orca', 'otter', 'owl', 'palm',
    'path', 'peak', 'pearl', 'petal', 'pike', 'pine', 'plum', 'pond',
    'quail', 'rain', 'raven', 'reed', 'reef', 'ridge', 'river', 'robin',
    'root', 'rose', 'sage', 'seal', 'shade', 'shell', 'shore', 'slate',
    'snail', 'spark', 'stone', 'storm', 'stork', 'thorn', 'tide', 'trail',
    'trout', 'tulip', 'vale', 'vine', 'viper', 'wave', 'wren', 'wolf',
];

async function generateSlug(attempts = 0) {
    if (attempts >= 10) throw new Error('Could not generate a unique paste slug after 10 attempts');
    const adj = SLUG_ADJECTIVES[crypto.randomInt(SLUG_ADJECTIVES.length)];
    const noun = SLUG_NOUNS[crypto.randomInt(SLUG_NOUNS.length)];
    const num = crypto.randomInt(10, 100); // 10–99
    const slug = `${adj}-${noun}-${num}`;
    const existing = await db.get('SELECT 1 FROM pastes WHERE slug = ?', [slug]);
    if (existing) return await generateSlug(attempts + 1);
    return slug;
}

module.exports = { SCREENSHOTS_DIR, generateSlug };
