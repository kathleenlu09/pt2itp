const Cursor = require('pg-cursor');
const turf = require('@turf/turf');
const Units = require('./units');

/**
 * @class Orphan
 */
class Orphan {
    constructor(pool, opts, output, post) {
        this.pool = pool;
        this.opts = opts;
        this.output = output;
        this.post = post;

        if (!opts.label && opts.tokens && (opts.tokens.indexOf('en') === -1)) {
            console.error('WARN: map.orphanAddr() using titlecase behavior, which is current English-only, on non-English data');
        }

        if (!opts.label) {
            this.label = require('./label/titlecase')({ language: 'en' });
        } else {
            this.label = require('./label/' + opts.label)();
        }
    }

    /**
     * Output all address_clusters not matched to a network_cluster
     * @param {Function} cb Callback in (err, res)
     * @return {Function} cb
     */
    address(cb) {
        const self = this;

        this.pool.connect((err, client, done) => {
            if (err) return cb(err);

            const cursor = client.query(new Cursor(`
                SELECT a._text AS address_text, n._text as network_text, ST_AsGeoJSON(a.geom) AS geom FROM address_cluster a LEFT JOIN network_cluster n ON a.id = n.address WHERE n.address IS NULL;
            `));

            return iterate();

            /**
             * Iterate over unmatched addresses using PG Cursor to avoid memory over utilization
             */
            function iterate() {
                cursor.read(1000, (err, rows) => {
                    if (err) return cb(err);

                    if (!rows.length) {
                        done();
                        return cb();
                    }

                    rows.forEach((row) => {
                        let feat = {
                            type: 'Feature',
                            properties: {
                                'carmen:text': self.label(row),
                                'carmen:center': false,
                                'carmen:addressnumber': []
                            },
                            geometry: {
                                type: 'GeometryCollection',
                                geometries: [{
                                    type: 'MultiPoint',
                                    coordinates: []
                                }]
                            }
                        };

                        let geom = JSON.parse(row.geom);

                        const units = new Units();

                        geom.coordinates.forEach((coord) => {
                            feat.properties['carmen:addressnumber'].push(units.decode(coord.pop()));
                            feat.geometry.geometries[0].coordinates.push(coord);
                        });

                        feat.properties['carmen:center'] = turf.pointOnSurface(feat.geometry.geometries[0]).geometry.coordinates;
                        feat.properties['carmen:addressnumber'] = [ feat.properties['carmen:addressnumber'] ];

                        if (self.opts.country) feat.properties['carmen:geocoder_stack'] = self.opts.country;

                        self.output.write(JSON.stringify(self.post.feat(feat)) + '\n');
                    });

                    return iterate();
                });
            }
        });
    }

    /**
     * Output all network_clusters not matched to an address_cluster
     * @param {Function} cb Callback in (err, res)
     * @return {Function} cb
     */
    network(cb) {
        const self = this;

        this.pool.connect((err, client, done) => {
            if (err) return cb(err);

            const cursor = client.query(new Cursor(`
                SELECT _text AS network_text, _text AS address_text,  ST_AsGeoJSON(geom) AS geom FROM network_cluster WHERE address IS NULL AND _text != '';
            `));

            return iterate();

            /**
             * Iterate over unmatched networks using PG Cursor to avoid memory over utilization
             */
            function iterate() {
                cursor.read(1000, (err, rows) => {
                    if (err) return cb(err);

                    if (!rows.length) {
                        done();
                        return cb();
                    }

                    for (let row of rows) {
                        row.geom = JSON.parse(row.geom);

                        if (turf.lineDistance(row.geom) < 0.001) continue;

                        let feat = {
                            type: 'Feature',
                            properties: {
                                'carmen:text': self.label(row),
                                'carmen:center': false,
                                'carmen:rangetype': 'tiger',
                                'carmen:parityl': [[]],
                                'carmen:parityr': [[]],
                                'carmen:lfromhn': [[]],
                                'carmen:rfromhn': [[]],
                                'carmen:ltohn': [[]],
                                'carmen:rtohn': [[]]
                            },
                            geometry: {
                                type: 'GeometryCollection',
                                geometries: [
                                    row.geom
                                ]
                            }
                        };

                        feat.properties['carmen:center'] = turf.pointOnSurface(feat.geometry.geometries[0]).geometry.coordinates;

                        if (self.opts.country) feat.properties['carmen:geocoder_stack'] = self.opts.country;

                        self.output.write(JSON.stringify(self.post.feat(feat)) + '\n');
                    }

                    return iterate();
                });
            }
        });
    }
}

module.exports = Orphan;
