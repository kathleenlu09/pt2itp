const tokens = require('@mapbox/geocoder-abbreviations')
const Queue = require('d3-queue').queue;
const Cursor = require('pg-cursor');
const CP = require('child_process');
const prog = require('progress');
const path = require('path');
const turf = require('@turf/turf');
const pg = require('pg');
const fs = require('fs');
const os = require('os');

const CPUS  = os.cpus().length;

const Cluster = require('./cluster');
const Orphan = require('./orphan');
const Index = require('./index');
const Post = require('./post');

const buffer = require('./buffer');
const split = require('./split');
const linesplit = require('split');
const tokenize = require('./tokenize');

/**
 * Main entrance to map module which combines address points and linestrings into clustered PT&ITP features in a carmen compatible spec
 * @param {Object} argv Argument Object - See argv parser or help module in code for a complete list
 * @param {Function} cb Callback in (err, res)
 * @return {Funtion} cb
 */
function main(argv, cb) {
    if (!cb || typeof cb !== 'function') throw new Error('lib/map.js requires a callback parameter');

    if (Array.isArray(argv)) {
        argv = require('minimist')(argv, {
            string: [
                'post',
                'output',
                'in-network',
                'in-address',
                'label',
                'map-network',
                'map-address',
                'error-network',
                'error-address',
                'segment',
                'tokens',
                'country',
                'db'
            ],
            boolean: [
                'name',
                'debug',
                'skip-import'
            ],
            alias: {
                'in-address': 'in-addresses',
                'map-address': 'map-addresses',
                'segments': 'segment',
                'database': 'db',
                'label': 'l',
                'output': 'o',
                'tokens': 'token'
            }
        });
    }

    if (!argv['in-address'] && !argv['skip-import']) {
        return cb(new Error('--in-address=<FILE.geojson> argument required'));
    } else if (!argv['in-network'] && !argv['skip-import']) {
        return cb(new Error('--in-network=<FILE.geojson> argument required'));
    } else if (!argv.output) {
        return cb(new Error('--output=<FILE.geojson> argument required'));
    } else if (!argv.db) {
        return cb(new Error('--db=<DATABASE> argument required'));
    }

    if (argv['map-network']) argv['map-network'] = path.resolve(__dirname, './map/', argv['map-network'] + '.js');
    if (argv['map-address']) argv['map-address'] = path.resolve(__dirname, './map/', argv['map-address'] + '.js');

    if (argv['error-network']) argv['error-network'] = fs.createWriteStream(path.resolve(__dirname, '..', argv['error-network']));
    if (argv['error-address']) argv['error-address'] = fs.createWriteStream(path.resolve(__dirname, '..', argv['error-address']));

    if (argv.segment) argv.segment = path.resolve(__dirname, '..',  argv.segment);

    let post;
    if (argv.post) {
        argv.post = argv.post.split(',');

        for (let p of argv.post) {
            if (['cardinality'].indexOf(argv.post) === -1) return cb(new Error(`unknown parameter '${p}' in --post flag`));
        }

        post = new Post(argv.post);
    } else {
        post = new Post();
    }

    let tokens;
    if (argv.tokens) {
        argv.tokens = argv.tokens.split(',')
        tokens = tokenize.createReplacer(argv.tokens);
    }

    const output = fs.createWriteStream(path.resolve(__dirname, '..', argv.output));

    const poolConf = {
        max: process.env.CI ? 10 : Math.min(16, CPUS),
        user: 'postgres',
        database: argv.db,
        idleTimeoutMillis: 30000
    }

    const pool = new pg.Pool(poolConf);

    const cluster = new Cluster(pool);
    const index = new Index(pool);
    const orphan = new Orphan(pool, argv, output, post);

    if (argv['skip-import']) {
        pool.query(`
            BEGIN;
                DELETE FROM address_cluster;
                DELETE FROM network_cluster;
            COMMIT;
        `, (err, res) => {
            if (err) return cb(err);

            return nameNetwork();
        });
    } else {
        createIndex();
    }

    /**
     * Create Tables, Import, & Optimize by generating indexes
     */
    function createIndex() {
        index.init((err) => {
            if (err) return cb(err);

            //Set Some Args to metatable - Don't wait for callback as we won't actually use those in this module - they are useful for debug/test/etc modes
            index.setMeta('tokens', tokens);
            index.setMeta('country', argv.country);

            indexQ = Queue();

            indexQ.defer((done) => {
                index.copy(argv['in-address'], 'address', {
                    tokens: tokens,
                    map: argv['map-address'],
                    error: argv['error-address']
                }, done);
            });

            indexQ.defer((done) => {
                index.copy(argv['in-network'], 'network', {
                    tokens: tokens,
                    error: argv['error-network'],
                    map: argv['map-network']
                }, done);
            });

            indexQ.awaitAll((err, res) => {
                if (err) return cb(err);

                console.error('ok - imported data');

                index.optimize(nameNetwork)
            });
        });
    }

    /**
     * Attempt to add names to any unanmed streets
     * @param {Error} err Any errors from parent function/step
     */
    function nameNetwork(err) {
        if (err) throw err;
        console.error('ok - optimized data')

        pool.connect((err, client, pg_done) => {
            if (err) return cb(err);

            client.query('SELECT count(*) FROM network WHERE text = \'\';', (err, res) => {
                if (err) return cb(err);

                const bar = new prog('ok - Interpolating Missing Names [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 20,
                    total: res.rows[0].count++
                });
                bar.tick(1);

                const cursor = client.query(new Cursor(`SELECT id FROM network WHERE text = '';`));

                let batch = 0;

                return iterate();

                /**
                 * Iterate over segments using PG Cursor to prevent excessive memory use
                 */
                function iterate() {
                    cursor.read(100, (err, rows) => {
                        if (!rows.length) {
                            pg_done();
                            console.error('ok - beginning segmenting');
                            return index.segment(argv.segment, null, clusterGeom);
                        }

                        const nameQ = Queue();

                        for (let row_it = 0; row_it < rows.length; row_it++) {
                            let row_id = rows[row_it].id;

                            nameQ.defer((id, done) => {
                                cluster.name(id, done);
                            }, row_id);
                        }

                        nameQ.await((err) => {
                            if (err) return cb(err);

                            console.error('ok - named unnamed streets ' + batch);
                            batch++;

                            bar.tick(rows.length);
                            return iterate();
                        });
                    });
                }
            });
        });
    }

    /**
     * Cluster individual LineString/Point geometries into MultiPoint/MultiLineString geometries based on geometric proximity
     */
    function clusterGeom(err, segs) {
        if (err) return cb(err);

        console.error('ok - geoms segmented');

        const clusterQ = Queue(parseInt(CPUS / 2));

        for (let seg of segs) {
            clusterQ.defer((seg, done) => {
                cluster.address(seg, done);
            }, seg);

            clusterQ.defer((seg, done) => {
                cluster.network(seg, done);
            }, seg);
        }

        clusterQ.await((err) => {
            if (err) return cb(err);

            console.error('ok - geometries clustered');

            cluster.optimize((err) => {
                if (err) return cb(err);

                console.error('ok - created cluster indexes');

                return matcher();
            });
        });
    }

    /**
     * Match network clusters with a proximal and textually similiar address cluster
     */
    function matcher() {
        pool.connect((err, client, pg_done) => {
            if (err) return cb(err);

            client.query(`SELECT id FROM network_cluster WHERE text != '' AND TEXT IS NOT NULL`, (err, res) => {
                if (err) return cb(err);

                if (res.rows[0].count === 0) return cb(new Error('Network Cluster has no geometries to cluster!'));

                const bar = new prog('ok - Cross Matching Data [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 20,
                    total: res.rows.length++
                });

                bar.tick(1); //Show progress bar

                let cpu_spawn = Math.min(Math.ceil(res.rows.length / 10000), CPUS); //number of 10000 groups or # of CPUs, whichever is smaller
                let nursery = [];

                let ids = res.rows.map((row) => { return row.id });

                while (cpu_spawn--) {

                    let child = CP.fork(path.resolve(__dirname, './match'), {
                        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
                    });

                    child.stdin.on('error', epipe);
                    child.stdout.on('error', epipe);
                    child.stderr.on('error', epipe);

                    child.on('message', (message) => {
                        if (message.error) return cb(err);

                        if (message.jobs) bar.tick(message.jobs);

                        if (!ids.length) {
                            nursery[message.id].active = false;
                            nursery[message.id].child.kill();

                            let active = nursery.filter((instance) => {
                                if (instance.active) return true;
                                else return false;
                            });

                            if (!active.length) {
                                pg_done();
                                console.error('ok - addresses assigned to linestring');
                                return adopt();
                            }
                        } else {
                            nursery[message.id].child.send(ids.splice(0, 10000));
                        }
                    });

                    let id = nursery.push({
                        active: true,
                        child: child
                    }) - 1;

                    child.send({
                        id: id,
                        pool: poolConf
                    });
                }
            });
        });
    }

    /**
     * Adopt address_clusters that are not in proximity to matched addressa_cluster but should be matched with the same network_cluster
     *          Line 1
     * ------------------------------
     * . . .                .   .   .
     *   A                      B
     *
     * By default Line 1 can only match with A or B not both,  detect these cases and group A & B together into a single cluster
     */
    function adopt() {
        return cluster.adoption(() => {
            console.error('ok - adopted stranded address clusters into stable homes');
            cluster.prune(() => {
                console.error('ok - pruned clusters');
                return collapse();
            });
        });
    }

    /**
     * Find network clusters that should be collapsed together prior to splitting
     */
    function collapse() {
        return cluster.collapse((err) => {
            if (err) throw new Error('cluster.collapse returned error: ' + err);
            console.error('ok - collapsed network clusters');
            return splitter();
        });
    }

    /**
     * Find clustest Segment in network for each address point in matched cluster and generate ITP output
     */
    function splitter() {
        pool.connect((err, client, pg_done) => {
            if (err) return cb(err);

            client.query(`SELECT id FROM network_cluster WHERE text != '' AND address IS NOT NULL;`, (err, res) => {
                if (err) return cb(err);

                if (res.rows[0].count === 0) return cb(new Error('Network Cluster has no geometries to cluster!'));

                const bar = new prog('ok - Splitting Data [:bar] :percent :etas', {
                    complete: '=',
                    incomplete: ' ',
                    width: 20,
                    total: res.rows.length++
                });

                bar.tick(1); //Show progress bar

                let cpu_spawn = Math.min(Math.ceil(res.rows.length / 1000), Math.min(16, CPUS)); //number of 1000 groups or # of CPUs, whichever is smaller
                let nursery = [];

                let ids = res.rows.map((row) => { return row.id });

                while (cpu_spawn--) {
                    let child = CP.fork(path.resolve(__dirname, './split'), {
                        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
                    });

                    child.stdin.on('error', epipe);
                    child.stdout.on('error', epipe);
                    child.stderr.on('error', epipe);

                    child.stdout
                        .pipe(linesplit())
                        .on('data', (line) => {
                            output.write(line + '\n');
                        });
                    child.stderr.pipe(process.stderr);

                    child.on('message', (message) => {
                        if (message.error) { return cb(new Error(`splitter child process error (${message.id}, jobs ${message.jobs}: ${message.error})`)); }

                        if (message.jobs) bar.tick(message.jobs);

                        if (!ids.length) {
                            if (message.type === 'end') {
                                // type == end means we have received the all-clear from a process that acted on a kill signal
                                nursery[message.id].active = false;
                                nursery[message.id].child.kill();

                                let active = nursery.filter((instance) => {
                                    if (instance.active) return true;
                                    else return false;
                                });

                                if (!active.length) {
                                    pg_done();
                                    return orphans();
                                }
                            } else {
                                // send kill signal so the pgpool can be shut down properly
                                nursery[message.id].child.send({ id: message.id, type: 'end' });
                            }
                        } else {
                            nursery[message.id].child.send(ids.splice(0, 1000));
                        }
                    });

                    let id = nursery.push({
                        active: true,
                        child: child
                    }) - 1;

                    opts = {
                        id: id,
                        post: argv.post,
                        country: argv.country,
                        debug: argv.debug,
                        tokens: argv.tokens,
                        pool: poolConf
                    };
                    if (argv.label) opts.label = argv.label;
                    if (!argv.label && argv.tokens && (argv.tokens.indexOf('en') === -1))
                        console.error('WARN: map.split() using titlecase behavior, which is currently English-only, on non-English data');
                    child.send(opts);
                }
            });
        });
    }

    /**
     * Output all address_clusters which were not matched to a network_cluster to retain the data
     * and also output all network_clusters not matched to an address_cluster to at least
     * allow searching for the street name
     */
    function orphans() {
        orphanQ = Queue();

        orphanQ.defer((done) => {
            orphan.address(done)
        });

        orphanQ.defer((done) => {
            orphan.network(done)
        });

        orphanQ.awaitAll(finalize);
    }

    /**
     * Close all used resources and prepare for termination
     */
    function finalize(err) {
        if (err)
            return cb(err);

        console.error('ok - pruned multiple network_clusters matched to the same address_cluster');

        if (argv['error-network']) argv['error-network'].close();
        if (argv['error-address']) argv['error-address'].close();

        output.end();
        pool.end();

        return cb();
    }

    /**
     * Standard pipe error handler
     * @param {Error} err
     * @return {Function} Call parent cb
     */
    function epipe(err) {
        console.error('not ok - epipe error');
        return cb(err);
    }
}

module.exports = main;
