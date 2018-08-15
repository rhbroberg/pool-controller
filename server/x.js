class foo {
	static registerMe() {
		console.log("registering using ", this.header());
	};
//	static header() {
//		return [0,0];
//	};
}

class bar extends foo {
	constructor() {
		super();
	}

	static header () {
		return [1,2];
	};
};


bar.registerMe();

var fooMe = {
	'0x01,0x02':	( (foo) => { console.log(`using ${foo}`); } ),
	'0x00,0x00':	( (bar) => { console.log(`zeros using ${bar} `); } )
};

fooMe['0x00,0x00']('abc');

