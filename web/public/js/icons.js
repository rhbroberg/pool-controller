// Line icons standing in for the app's SF Symbols, drawn on a 24-point grid.

import { s } from './dom.js';

const path = (d) => ['path', { d }];
const circle = (cx, cy, r) => ['circle', { cx, cy, r }];
const rect = (x, y, width, height, rx = 0) => ['rect', { x, y, width, height, rx }];

const ICONS = {
    gear: [
        path('M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'),
        circle(12, 12, 3)
    ],
    flame: [path('M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z')],
    heatWaves: [
        path('M7 3c-2 3 2 6 0 9s2 6 0 9'),
        path('M12 3c-2 3 2 6 0 9s2 6 0 9'),
        path('M17 3c-2 3 2 6 0 9s2 6 0 9')
    ],
    fan: [
        path('M10.83 16.38a6.08 6.08 0 0 1-8.62-7l5.41 1.45a6.08 6.08 0 0 1 7-8.62l-1.45 5.41a6.08 6.08 0 0 1 8.62 7l-5.41-1.45a6.08 6.08 0 0 1-7 8.62l1.45-5.41Z'),
        path('M12 12v.01')
    ],
    bath: [
        path('M3 12h18v2a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z'),
        path('M6 12V5a2 2 0 0 1 4 0'),
        path('M7 19l-1 2'),
        path('M17 19l1 2')
    ],
    lightbulb: [
        path('M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5z'),
        path('M9 18h6'),
        path('M10 22h4')
    ],
    lamp: [path('M8 2h8l3 7H5z'), path('M12 9v13'), path('M8 22h8')],
    wind: [
        path('M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2'),
        path('M9.6 4.6A2 2 0 1 1 11 8H2'),
        path('M12.6 19.4A2 2 0 1 0 14 16H2')
    ],
    bubbles: [circle(8.5, 15, 4.5), circle(16.5, 7.5, 3), circle(18, 17, 2)],
    lock: [rect(4, 11, 16, 11, 2), path('M8 11V7a4 4 0 0 1 8 0v4')],
    eye: [path('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z'), circle(12, 12, 3)],
    eyeOff: [
        path('M3 3l18 18'),
        path('M10.6 10.6a2 2 0 0 0 2.8 2.8'),
        path('M9.9 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.7'),
        path('M6.6 6.6A13 13 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6')
    ],
    wifiOff: [
        path('M2 2l20 20'),
        path('M8.5 16.5a5 5 0 0 1 7 0'),
        path('M2 8.8a15 15 0 0 1 4.2-2.6'),
        path('M10.7 5.1A15 15 0 0 1 22 8.8'),
        path('M5 12.9a10 10 0 0 1 5.2-2.7'),
        path('M16.8 11.1A10 10 0 0 1 19 12.9'),
        path('M12 20h.01')
    ],
    warning: [
        path('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
        path('M12 9v4'),
        path('M12 17h.01')
    ],
    chevronRight: [path('m9 18 6-6-6-6')],
    chevronLeft: [path('m15 18-6-6 6-6')],
    chevronDown: [path('m6 9 6 6 6-6')],
    thermometer: [path('M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z')],
    target: [circle(12, 12, 9), circle(12, 12, 5), circle(12, 12, 1)],
    wrench: [path('M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z')],
    grains: [circle(7, 7, 2.2), circle(17, 7, 2.2), circle(12, 12, 2.2), circle(7, 17, 2.2), circle(17, 17, 2.2)],
    dpad: [path('M9 3h6v6h6v6h-6v6H9v-6H3V9h6z')],
    branch: [path('M6 3v12'), circle(18, 6, 3), circle(6, 18, 3), path('M18 9a9 9 0 0 1-9 9')],
    plus: [path('M5 12h14'), path('M12 5v14')],
    minus: [path('M5 12h14')],
    lessThan: [path('m16 5-8 7 8 7')],
    greaterThan: [path('m8 5 8 7-8 7')],
    zoomIn: [circle(11, 11, 7), path('m20 20-4-4'), path('M11 8v6'), path('M8 11h6')],
    zoomOut: [circle(11, 11, 7), path('m20 20-4-4'), path('M8 11h6')],
    user: [circle(12, 7, 4), path('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2')],
    userCircle: [circle(12, 12, 10), circle(12, 10, 3), path('M7 20.66V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.66')],
    users: [
        circle(9, 7, 4),
        path('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'),
        path('M22 21v-2a4 4 0 0 0-3-3.87'),
        path('M16 3.13a4 4 0 0 1 0 7.75')
    ],
    toggle: [rect(2, 6, 20, 12, 6), circle(8, 12, 2.5)],
    keyboard: [rect(2, 5, 20, 14, 2), path('M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 16h10')],
    check: [path('M20 6 9 17l-5-5')],
    clock: [circle(12, 12, 9), path('M12 7v5l3 2')],
    calendar: [rect(3, 5, 18, 16, 2), path('M3 10h18'), path('M8 3v4'), path('M16 3v4'), path('M7 14h.01M12 14h.01M17 14h.01M7 18h.01M12 18h.01')],
    x: [path('M18 6 6 18'), path('m6 6 12 12')],
    pause: [circle(12, 12, 9), path('M10 15V9'), path('M14 15V9')],
    waves: [
        path('M2 6c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0'),
        path('M2 12c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0'),
        path('M2 18c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0')
    ],
    sort: [path('m21 16-4 4-4-4'), path('M17 20V4'), path('m3 8 4-4 4 4'), path('M7 4v16')],
    refresh: [path('M21 12a9 9 0 1 1-2.64-6.36L21 8'), path('M21 3v5h-5')],
    list: [path('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01')],
    filter: [path('M22 3H2l8 9.46V19l4 2v-8.54z')],
    drop: [path('M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z')],
    trash: [path('M3 6h18'), path('M8 6V4h8v2'), path('M19 6l-1 14H6L5 6')],
    sun: [
        circle(12, 12, 4),
        path('M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41')
    ],
    cloud: [path('M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z')],
    cloudSun: [
        path('M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41'),
        path('M15.95 12.65A4 4 0 0 0 8.4 9.5'),
        path('M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z')
    ],
    cloudRain: [
        path('M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24'),
        path('M16 14v6M8 14v6M12 16v6')
    ],
    cloudFog: [
        path('M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24'),
        path('M16 17H7M17 21H9')
    ],
    cloudLightning: [
        path('M6 16.33A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.97'),
        path('m13 12-3 5h4l-3 5')
    ],
    snowflake: [
        path('M2 12h20M12 2v20'),
        path('m20 16-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4')
    ]
};

/**
 * an inline SVG icon; filled shades the shape in its colour, as SF Symbols' fill variant does
 **/
export const icon = (name, { filled = false, className = '', label } = {}) => {
    const parts = ICONS[name] || [];
    return s('svg', {
        class: ['icon', filled ? 'filled' : '', className],
        viewBox: '0 0 24 24',
        'aria-hidden': label ? null : 'true',
        role: label ? 'img' : null,
        'aria-label': label || null
    }, label ? s('title', null, label) : null, parts.map(([tag, attrs]) => s(tag, attrs)));
};
