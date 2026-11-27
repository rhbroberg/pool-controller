// A guest's QR code: its link, which a phone's camera opens in the browser and the iPhone app's
// QR button reads, to let the guest in once to choose a password.

import qrcode from '../libs/qrcode.js';
import { h, openDialog } from '../dom.js';
import { icon } from '../icons.js';
import { guestLink } from '../model.js';
import { formatMonthDayYearTime } from '../format.js';
import { sheetHeader } from '../ui.js';

// pixels per module, and the quiet zone around the code in modules, which scanners need
const SCALE = 8;
const MARGIN = 4;

/** a PNG data URL of text as a QR code, black on white whatever the page's colours */
export const qrDataUrl = (text: string) => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const size = (count + MARGIN * 2) * SCALE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Couldn’t draw a QR code.');
    }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#000';
    for (let row = 0; row < count; row++) {
        for (let column = 0; column < count; column++) {
            if (qr.isDark(row, column)) {
                context.fillRect((column + MARGIN) * SCALE, (row + MARGIN) * SCALE, SCALE, SCALE);
            }
        }
    }
    return canvas.toDataURL('image/png');
};

/**
 * puts the QR code on the clipboard as an image, with the link as text where the browser takes
 * both; resolves with what was copied: 'image' or 'link'
 **/
export const copyQr = async (account: { email: string; setupCode?: string | null }) => {
    const link = guestLink(location.origin, account);
    const image = await (await fetch(qrDataUrl(link))).blob();
    const text = new Blob([link], { type: 'text/plain' });
    const attempts: Array<Record<string, Blob>> = [{ 'image/png': image, 'text/plain': text }, { 'image/png': image }];
    if (typeof ClipboardItem === 'function') {
        for (const items of attempts) {
            try {
                await navigator.clipboard.write([new ClipboardItem(items)]);
                return 'image' as const;
            } catch {
                // some browsers take only one kind at a time, or no images
            }
        }
    }
    await navigator.clipboard.writeText(link);
    return 'link' as const;
};

/** shows a guest's QR code and link, with a way to copy it */
export const openGuestQr = (account: {
    email: string;
    setupCode?: string | null;
    expiresAt?: string | number | Date | null;
}) => {
    const link = guestLink(location.origin, account);
    const image = qrDataUrl(link);
    let copied: string | null = null;

    const copy = async () => {
        try {
            copied = (await copyQr(account)) === 'image' ? 'Copied the QR code.' : 'Copied the link.';
        } catch {
            copied = 'Couldn’t copy. Select the link and copy it instead.';
        }
        dialog.update();
    };

    const render = (close: () => void) => [
        sheetHeader({
            title: account.email,
            trailing: h('button', { class: 'bar-button strong', type: 'button', onClick: () => close() }, 'Done')
        }),
        h('div', { class: 'sheet-content guest-qr' },
            h('img', { class: 'qr-image', src: image, alt: `QR code for ${account.email}`, width: 240, height: 240 }),
            h('p', { class: 'qr-help' }, account.setupCode
                ? `Scan it with a phone’s camera. With Pool Status installed it opens the app and signs ${account.email} in to choose a password; otherwise it does the same in the browser.`
                : `${account.email} has chosen a password. The code now opens the sign-in with the name filled in.`),
            account.expiresAt ? h('p', { class: 'qr-help' }, `Expires ${formatMonthDayYearTime(new Date(account.expiresAt))}.`) : null,
            h('div', { class: 'qr-link' }, link),
            h('button', { class: 'button', type: 'button', onClick: copy }, icon('copy'), 'Copy QR Code'),
            copied ? h('p', { class: 'qr-help', role: 'status' }, copied) : null)
    ];

    const dialog = openDialog(render, { className: 'sheet' });
    return dialog.result;
};