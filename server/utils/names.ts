'use strict';
// Names for guest accounts, two common words run together as Docker names its containers, so
// they're easy to read off a phone and say aloud: "sunny-otter".

import crypto from 'crypto';

const ADJECTIVES = [
    'amber', 'brave', 'breezy', 'bright', 'calm', 'cheerful', 'clever', 'cool', 'cozy', 'crisp',
    'daring', 'dreamy', 'eager', 'easy', 'fancy', 'gentle', 'golden', 'happy', 'jolly', 'kind',
    'lazy', 'lively', 'lucky', 'mellow', 'merry', 'misty', 'nimble', 'noble', 'peppy', 'plucky',
    'proud', 'quick', 'quiet', 'rapid', 'rosy', 'shiny', 'silly', 'sleepy', 'snappy', 'sparkly',
    'speedy', 'sunny', 'swift', 'tidy', 'trusty', 'witty', 'zesty', 'bubbly', 'chilly', 'salty'
];

const NOUNS = [
    'badger', 'beacon', 'canoe', 'cedar', 'comet', 'coral', 'dolphin', 'falcon', 'ferret', 'finch',
    'flamingo', 'harbor', 'heron', 'island', 'koala', 'lagoon', 'lantern', 'lemon', 'lobster', 'maple',
    'meadow', 'otter', 'paddle', 'panda', 'pebble', 'pelican', 'penguin', 'pine', 'puffin', 'rabbit',
    'raven', 'reef', 'river', 'robin', 'sail', 'seal', 'shell', 'sparrow', 'starfish', 'surf',
    'tide', 'turtle', 'walrus', 'wave', 'whale', 'willow', 'wren', 'yacht', 'zebra', 'snorkel'
];

const pick = (words: string[]) => words[crypto.randomInt(words.length)];

/** "sunny-otter" */
var guestName = () => `${pick(ADJECTIVES)}-${pick(NOUNS)}`;

/** a one-time code for a guest's link: 16 characters that need no escaping in a URL */
var setupCode = () => crypto.randomBytes(12).toString('base64url');

export { guestName, setupCode, ADJECTIVES, NOUNS };