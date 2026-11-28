'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSetpointText, adjustPlan, writeSetpoint, readSetpoint } = require('../protocol/setpointMenu');

describe('setpoint menu parsing', () => {
    it('reads Off, Manual Off, and degree values from the Settings value line', () => {
        assert.equal(parseSetpointText('Off'), 'off');
        assert.equal(parseSetpointText('Manual Off'), 'off');
        assert.equal(parseSetpointText('104°F'), 104);
        assert.equal(parseSetpointText('  80°F '), 80);
        assert.equal(parseSetpointText('Priority: Never'), undefined);
        assert.equal(parseSetpointText('Priority: Always'), undefined);
    });

    it('picks the shorter +/− path on the Off/65…104 ring', () => {
        assert.deepEqual(adjustPlan(80, 82), { key: 'plus', count: 2 });
        assert.deepEqual(adjustPlan(82, 80), { key: 'minus', count: 2 });
        assert.deepEqual(adjustPlan('off', 65), { key: 'plus', count: 1 });
        assert.deepEqual(adjustPlan(104, 'off'), { key: 'plus', count: 1 });
        assert.deepEqual(adjustPlan('off', 104), { key: 'minus', count: 1 });
    });
});

describe('setpoint menu navigation', () => {
    const scripted = (screens: string[][]) => {
        let i = 0;
        const presses: string[] = [];
        return {
            presses,
            port: {
                press: async (key: string) => {
                    presses.push(key);
                    i = Math.min(i + 1, screens.length - 1);
                },
                display: async () => {
                    const lines = screens[i] || screens[screens.length - 1];
                    return { lines: lines.map((l) => l.padEnd(20).slice(0, 20)), blinking: [[], []] };
                },
                settleMs: 5
            }
        };
    };

    it('reads spa heater1 by MENU to Settings then RIGHT to the row, then back to Default', async () => {
        const { port, presses } = scripted([
            ['      Wednesday      ', '       10:00A       '],
            ['      Settings      ', '        Menu        '],
            ['    Spa Heater1     ', '       104°F        '],
            ['       Timers       ', '        Menu        '],
            ['      Default       ', '        Menu        ']
        ]);
        const value = await readSetpoint(port, 'spa', 'heater1');
        assert.equal(value, 104);
        assert.ok(presses.includes('menu'));
        assert.ok(presses.includes('right'));
        assert.ok(presses.filter((k) => k === 'menu').length >= 2, 'MENU again to leave Settings for Default');
    });

    it('writes pool heatpump by stepping +/− then RIGHT to lock in, then back to Default', async () => {
        const screens = [
            ['      Settings      ', '        Menu        '],
            ['   Pool Heat Pump   ', '        78°F        '],
            ['   Pool Heat Pump   ', '        79°F        '],
            ['   Pool Heat Pump   ', '        80°F        '],
            ['   Spa Heat Pump    ', '  Priority: Never   '],
            ['       Timers       ', '        Menu        '],
            ['      Default       ', '        Menu        ']
        ];
        let i = 0;
        const presses: string[] = [];
        const port = {
            settleMs: 5,
            press: async (key: string) => {
                presses.push(key);
                if (key === 'right' || key === 'plus' || key === 'minus' || key === 'menu') {
                    i = Math.min(i + 1, screens.length - 1);
                }
            },
            display: async () => ({
                lines: screens[i].map((l) => l.padEnd(20).slice(0, 20)),
                blinking: [[], []]
            })
        };
        const written = await writeSetpoint(port, 'pool', 'heatpump', 80);
        assert.equal(written, 80);
        assert.ok(presses.filter((k) => k === 'plus').length >= 2);
        assert.ok(presses.includes('right'));
        assert.equal(presses[presses.length - 1], 'menu');
    });

    it('skips Spa Heat Pump Priority when hunting the Spa Heat Pump setpoint row', async () => {
        const seq = [
            ['      Settings      ', '        Menu        '],
            ['   Spa Heat Pump    ', '  Priority: Always  '],
            ['   Spa Heat Pump    ', '    Manual Off      '],
            ['      Default       ', '        Menu        ']
        ];
        let step = 0;
        const presses: string[] = [];
        const port = {
            settleMs: 5,
            press: async (key: string) => {
                presses.push(key);
                step = Math.min(step + 1, seq.length - 1);
            },
            display: async () => ({
                lines: seq[step].map((l) => l.padEnd(20).slice(0, 20)),
                blinking: [[], []]
            })
        };
        const value = await readSetpoint(port, 'spa', 'heatpump');
        assert.equal(value, 'off');
        assert.ok(presses.filter((k) => k === 'right').length >= 2, 'must RIGHT past the Priority lookalike');
        assert.ok(presses[presses.length - 1] === 'menu' || presses.includes('menu'));
    });
});
