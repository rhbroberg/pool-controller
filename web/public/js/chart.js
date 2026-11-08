// A time chart drawn as SVG: stepped lines, shaded bands and a selection rule. Lines step,
// because the server stores a reading only when it changes.

const MARGIN = { top: 8, right: 10, bottom: 24, left: 46 };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIME_STEPS = [10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
    DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 61 * DAY, 91 * DAY];
const MINIMUM_TICK_SPACING = 80;

let nextId = 0;

const escapeText = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** about count round values from low to high */
export const niceTicks = (low, high, count = 5) => {
    const span = high - low;
    if (!(span > 0)) {
        return [low];
    }
    const rough = span / count;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) || 10 * magnitude;
    const ticks = [];
    for (let value = Math.ceil(low / step) * step; value <= high + step * 1e-9; value += step) {
        ticks.push(Number(value.toFixed(10)));
    }
    return ticks;
};

/** times for the x axis between from and to, on local hour, day or month boundaries */
export const timeTicks = (from, to, maxCount) => {
    const span = to - from;
    const step = TIME_STEPS.find((s) => span / s <= maxCount) || TIME_STEPS[TIME_STEPS.length - 1];
    const ticks = [];
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    if (step >= 30 * DAY) {
        const months = Math.round(step / (30 * DAY));
        start.setDate(1);
        start.setMonth(start.getMonth() - (start.getMonth() % months));
        for (const date = start; date.getTime() <= to; date.setMonth(date.getMonth() + months)) {
            if (date.getTime() >= from) {
                ticks.push(date.getTime());
            }
        }
    } else if (step >= DAY) {
        const days = Math.round(step / DAY);
        for (const date = start; date.getTime() <= to; date.setDate(date.getDate() + days)) {
            if (date.getTime() >= from) {
                ticks.push(date.getTime());
            }
        }
    } else {
        for (let t = start.getTime(); t <= to; t += step) {
            if (t >= from) {
                ticks.push(t);
            }
        }
    }
    return { ticks, step };
};

/** a stepped band from each point's low to its high, holding to the next point */
const rangePath = (points, x, y) => {
    if (points.length < 2) {
        return '';
    }
    const top = [];
    const bottom = [];
    for (let i = 0; i < points.length - 1; i++) {
        const left = x(points[i].t).toFixed(1);
        const right = x(points[i + 1].t).toFixed(1);
        top.push(`${left},${y(points[i].high).toFixed(1)}`, `${right},${y(points[i].high).toFixed(1)}`);
        bottom.unshift(`${right},${y(points[i].low).toFixed(1)}`, `${left},${y(points[i].low).toFixed(1)}`);
    }
    return `M${[...top, ...bottom].join('L')}Z`;
};

const stepPath = (points, x, y) => {
    if (!points.length) {
        return '';
    }
    let d = `M${x(points[0].t).toFixed(1)},${y(points[0].v).toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
        d += `H${x(points[i].t).toFixed(1)}V${y(points[i].v).toFixed(1)}`;
    }
    return d;
};

/** the points from..to and one either side, so the line runs to the edges */
const visible = (points, from, to) => {
    let first = 0;
    while (first < points.length - 1 && points[first + 1].t < from) {
        first++;
    }
    let last = points.length - 1;
    while (last > 0 && points[last - 1].t > to) {
        last--;
    }
    return points.slice(first, last + 1);
};

export class TimeChart {
    /**
     * yLabel formats a y axis value; tickLabel formats a time given the tick step in ms
     **/
    constructor(container, { yLabel = (v) => String(v), tickLabel = (t) => new Date(t).toLocaleString() } = {}) {
        this.container = container;
        this.yLabel = yLabel;
        this.tickLabel = tickLabel;
        this.id = `chart-${nextId++}`;
        this.spec = null;
        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.setAttribute('role', 'img');
        container.appendChild(this.svg);
        this.observer = new ResizeObserver(() => this.render());
        this.observer.observe(container);
    }

    get size() {
        return { width: this.container.clientWidth, height: this.container.clientHeight };
    }

    get plot() {
        const { width, height } = this.size;
        return {
            left: MARGIN.left,
            top: MARGIN.top,
            width: Math.max(1, width - MARGIN.left - MARGIN.right),
            height: Math.max(1, height - MARGIN.top - MARGIN.bottom)
        };
    }

    /** the time under a pointer at clientX */
    timeAt(clientX) {
        if (!this.spec) {
            return null;
        }
        const plot = this.plot;
        const box = this.container.getBoundingClientRect();
        const fraction = (clientX - box.left - plot.left) / plot.width;
        return this.spec.from + Math.min(1, Math.max(0, fraction)) * (this.spec.to - this.spec.from);
    }

    /** the plot's width in device pixels, for asking for about one point per pixel */
    get devicePixels() {
        return this.plot.width * (globalThis.devicePixelRatio || 1);
    }

    /** milliseconds one pixel spans */
    get msPerPixel() {
        return this.spec ? (this.spec.to - this.spec.from) / this.plot.width : 0;
    }

    /**
     * spec: { from, to, yMin, yMax, label, bands: [{ start, end, color, opacity }],
     * ranges: [{ points: [{ t, low, high }], color, opacity }],
     * lines: [{ points: [{ t, v }], color, width, dash }], dots: [{ t, v, color }], rule }
     **/
    set(spec) {
        this.spec = spec;
        this.render();
    }

    render() {
        const spec = this.spec;
        const { width, height } = this.size;
        if (!spec || !width || !height) {
            return;
        }
        const plot = this.plot;
        const { from, to, yMin, yMax } = spec;
        const x = (t) => plot.left + ((t - from) / (to - from)) * plot.width;
        const y = (v) => plot.top + (1 - (v - yMin) / (yMax - yMin)) * plot.height;
        const clip = `${this.id}-clip`;
        const parts = [];

        parts.push(`<defs><clipPath id="${clip}"><rect x="${plot.left}" y="${plot.top - 2}" width="${plot.width}" height="${plot.height + 4}"/></clipPath></defs>`);

        const yTicks = niceTicks(yMin, yMax, Math.max(2, Math.floor(plot.height / 45)));
        const { ticks: xTicks, step } = timeTicks(from, to, Math.max(2, Math.floor(plot.width / MINIMUM_TICK_SPACING)));
        parts.push('<g class="grid">');
        yTicks.forEach((v) => parts.push(`<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`));
        xTicks.forEach((t) => parts.push(`<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${plot.top}" y2="${plot.top + plot.height}"/>`));
        parts.push('</g><g class="axis">');
        yTicks.forEach((v) => parts.push(`<text x="${plot.left - 6}" y="${y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${escapeText(this.yLabel(v))}</text>`));
        xTicks.forEach((t) => parts.push(`<text x="${x(t).toFixed(1)}" y="${plot.top + plot.height + 16}" text-anchor="middle">${escapeText(this.tickLabel(t, step))}</text>`));
        parts.push('</g>');

        parts.push(`<g clip-path="url(#${clip})">`);
        (spec.bands || []).forEach((band) => {
            if (band.end < from || band.start > to) {
                return;
            }
            const left = Math.max(plot.left - 1, x(band.start));
            const right = Math.min(plot.left + plot.width + 1, x(band.end));
            parts.push(`<rect x="${left.toFixed(1)}" y="${plot.top}" width="${Math.max(1, right - left).toFixed(1)}" height="${plot.height}" style="fill:${band.color};fill-opacity:${band.opacity}"/>`);
        });
        (spec.ranges || []).forEach((range) => {
            const points = visible(range.points, from, to).filter((p) => p.low !== null && p.high !== null);
            if (points.length < 2) {
                return;
            }
            parts.push(`<path d="${rangePath(points, x, y)}" style="fill:${range.color};fill-opacity:${range.opacity};stroke:none"/>`);
        });
        (spec.lines || []).forEach((line) => {
            const points = visible(line.points, from, to);
            if (!points.length) {
                return;
            }
            const dash = line.dash ? `;stroke-dasharray:${line.dash}` : '';
            parts.push(`<path d="${stepPath(points, x, y)}" style="fill:none;stroke:${line.color};stroke-width:${line.width || 2};stroke-linejoin:round${dash}"/>`);
        });
        (spec.dots || []).forEach((dot) => {
            if (dot.t >= from && dot.t <= to) {
                parts.push(`<circle cx="${x(dot.t).toFixed(1)}" cy="${y(dot.v).toFixed(1)}" r="${dot.r || 3.5}" style="fill:${dot.color}"/>`);
            }
        });
        if (spec.rule !== null && spec.rule !== undefined) {
            parts.push(`<line class="rule" x1="${x(spec.rule).toFixed(1)}" x2="${x(spec.rule).toFixed(1)}" y1="${plot.top}" y2="${plot.top + plot.height}"/>`);
        }
        parts.push('</g>');

        this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        this.svg.setAttribute('aria-label', spec.label || '');
        this.svg.innerHTML = parts.join('');
    }

    destroy() {
        this.observer.disconnect();
        this.svg.remove();
    }
}
