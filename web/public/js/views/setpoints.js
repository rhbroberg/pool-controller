// The pool and spa setpoints for the heater or the heat pump, in a sheet over the dashboard.

import { h, openDialog } from '../dom.js';
import { icon } from '../icons.js';
import { WATER_BODIES, setpointOf } from '../model.js';
import { formSection, formRow, sheetHeader, spinner } from '../ui.js';

const DEFAULT_RANGE = [65, 104];
const DEFAULT_SETPOINT = 80;

export const openSetpoints = (app, device) => {
    const { store } = app;
    const drafts = {};
    WATER_BODIES.forEach((body) => {
        drafts[body.id] = setpointOf(store.heating, device.id, body.id) ?? DEFAULT_SETPOINT;
    });
    let saving = false;
    let errorMessage = null;

    const explanation = () => {
        const parts = [`The ${device.title.toLowerCase()} heats the spa while the spa filter runs, and otherwise the pool while the filter runs in Pool or Spillover flow. Once that water reaches its setpoint it stops, and starts again when the water cools below it.`];
        if (store.heating && store.heating.setpointsReachController === false) {
            parts.push('For now the server keeps these setpoints itself; they aren’t read from or sent to the controller yet.');
        }
        if (!store.credentials) {
            parts.push('Sign in to change them.');
        } else if (!store.canControl) {
            parts.push('Your account can see the setpoints but not change them.');
        }
        return parts.join(' ');
    };

    const hasChanges = () => WATER_BODIES.some((body) => drafts[body.id] !== setpointOf(store.heating, device.id, body.id));

    const step = (body, delta, [low, high]) => {
        drafts[body.id] = Math.min(high, Math.max(low, drafts[body.id] + delta));
        sheet.update();
    };

    const save = (close) => {
        saving = true;
        errorMessage = null;
        sheet.update();
        store.setSetpoints({ ...drafts }, device.id)
            .then(() => close(true))
            .catch((error) => {
                errorMessage = error.message;
            })
            .finally(() => {
                saving = false;
                sheet.update();
            });
    };

    const render = (close) => {
        const heating = store.heating;
        const range = heating ? [heating.minimum, heating.maximum] : DEFAULT_RANGE;
        const disabled = !store.canControl || saving;
        const row = (body) => {
            const value = drafts[body.id];
            return formRow(
                h('div', { class: 'row-text' },
                    h('span', null, body.title),
                    heating && heating.target === body.id ? h('small', null, 'Water is flowing here now') : null),
                h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' } },
                    h('span', { class: 'stepper-value', 'aria-live': 'polite' }, `${value}°F`),
                    h('div', { class: 'stepper', role: 'group', 'aria-label': `${body.title} setpoint` },
                        h('button', { type: 'button', 'aria-label': `Lower the ${body.title.toLowerCase()} setpoint`, disabled: disabled || value <= range[0], onClick: () => step(body, -1, range) }, icon('minus')),
                        h('button', { type: 'button', 'aria-label': `Raise the ${body.title.toLowerCase()} setpoint`, disabled: disabled || value >= range[1], onClick: () => step(body, 1, range) }, icon('plus')))));
        };
        return [
            sheetHeader({
                title: `${device.title} Setpoints`,
                leading: h('button', { class: 'bar-button', type: 'button', onClick: () => close() }, store.canControl ? 'Cancel' : 'Done'),
                trailing: store.canControl
                    ? (saving ? spinner() : h('button', { class: 'bar-button strong', type: 'button', disabled: !hasChanges(), onClick: () => save(close) }, 'Save'))
                    : null
            }),
            h('div', { class: 'sheet-content form' },
                formSection({ footer: explanation() }, ...WATER_BODIES.map(row)),
                errorMessage ? formSection({}, h('div', { class: 'message-box error-text' }, errorMessage)) : null)
        ];
    };

    const sheet = openDialog(render, { className: 'sheet' });
    const unsubscribe = store.subscribe(() => sheet.update());
    sheet.result.then(unsubscribe);
    return sheet.result;
};
