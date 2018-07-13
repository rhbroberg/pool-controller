class TwoWayMap {
    constructor(map) {
        this.map = map;
        this.reverseMap = {};

        for (var key in map) {
            var value = map[key];
            this.reverseMap[value] = key;
        }
    }
    get(key) { return this.map[key]; }
    revGet(key) { return this.reverseMap[key]; }
}

module.exports = { TwoWayMap };
