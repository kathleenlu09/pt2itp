const buffer = require('./buffer');
const dist = require('fast-levenshtein').get;
const Cursor = require('pg-cursor');
const turf = require('@turf/turf');
const Queue = require('d3-queue').queue;
const _ = require('lodash');
const wk = require('wellknown');
const simple = require('simple-statistics');
const Misc = require('./misc');
const misc = new Misc();

/**
 * @class Cluster
 */
class Cluster {
    constructor(pool) {
        this.pool = pool;
    }

    break(segs) {
        let newSegs = []; //Break apart cluster into two new clusters

        let orphanSegs = []; //Segs that needs to be matched based on prox. at the end with segments in newSegs

        for (let seg of segs) {
            if (!seg.address || turf.lineDistance(seg.network) < 1) {
                orphanSegs.push(seg);
                continue;
            }

            let dist = [];

            for (let addr_it = 0; addr_it < seg.number.length; addr_it++) {
                let addr = turf.point(seg.address.geometry.coordinates[addr_it]);
                let linept = turf.pointOnLine(seg.network, addr);

                let res = {
                    'distOnLine': turf.lineDistance(turf.lineSlice(turf.point(seg.network.geometry.coordinates[0]), linept, seg.network), 'kilometers'),
                    'distFromLine': turf.distance(addr, linept, 'kilometers'),
                    'geometry': addr,
                    'number': parseInt(seg.number[addr_it])
                };

                dist.push(res);
            }

            //Sort from origin => end
            dist.sort((a, b) => {
                if (a.distOnLine < b.distOnLine) return -1;
                if (a.distOnLine > b.distOnLine) return 1;
                if (a.distOnLine === b.distOnLine) {
                    return a.distFromLine - b.distFromLine;
                }
            });

            let distDelta = [];
            for (let d_it = 1; d_it < dist.length; d_it++) {
                let deltaNum = dist[d_it].number - dist[d_it - 1].number;
                distDelta.push([dist[d_it].distOnLine, deltaNum > 0 ? 1 : -1]);
            }

            let ln = simple.linearRegression(distDelta)

            if (isNaN(ln.b) || isNaN(ln.m)) {
                orphanSegs.push(seg);
                continue;
            }

            let xInt = (-ln.b) / ln.m;

            //XIntercept is before or after the line
            if (isNaN(xInt) || xInt <= 0 || xInt >= turf.lineDistance(seg.network)) {
                orphanSegs.push(seg);
                continue;
            }

            let networkStart = turf.lineSliceAlong(seg.network, 0, xInt)
            let networkEnd = turf.lineSliceAlong(seg.network, xInt, turf.lineDistance(seg.network));

            if (turf.lineDistance(networkStart) < 0.001 || turf.lineDistance(networkEnd) < 0.001) return false;


            let tmpSeg = [{
                network: networkStart,
                address: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'MultiPoint',
                        coordinates: []
                    }
                },
                number: []
            },{
                network: networkEnd,
                address: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'MultiPoint',
                        coordinates: []
                    }
                },
                number: []
            }];

            for (let d_it = 0; d_it < dist.length; d_it++) {
                if (dist[d_it].distOnLine < xInt) {
                    tmpSeg[0].number.push(dist[d_it].number);
                    tmpSeg[0].address.geometry.coordinates.push(dist[d_it].geometry.geometry.coordinates);
                } else {
                    tmpSeg[1].number.push(dist[d_it].number);
                    tmpSeg[1].address.geometry.coordinates.push(dist[d_it].geometry.geometry.coordinates);
                }
            }

            newSegs.push([tmpSeg[0]]);
            newSegs.push([tmpSeg[1]]);
        }

        if (!newSegs.length) return false; //No change between new & original segs

        for (let oSeg of orphanSegs) {
            let closest = {
                dist: false,
                ele: false
            }

            for (let n_it = 0; n_it < newSegs.length; n_it++) {
                let segs = newSegs[n_it];

                let d = turf.distance(turf.center(oSeg.network), turf.center(turf.featureCollection(segs.map((seg) => { return seg.network}))))

                if (!closest.dist || closest.dist > d) {
                    closest.dist = d;
                    closest.ele = n_it;
                }
            }

            newSegs[closest.ele].push(oSeg);
        }

        return newSegs;
    }

    /**
     * Cluster address points within a given segment
     * @param {boolean} segment Segment ID to cluster within
     * @param {Function} cb Callback in (err, res)
     * @return {Function} Callback
     */
    address(segment = 1, cb) {
        this.pool.query(`
            INSERT INTO address_cluster (text, _text, text_tokenless, geom)
                SELECT
                    addr.text,
                    addr._text,
                    addr.text_tokenless,
                    ST_Multi(ST_CollectionExtract(addr.geom, 1)) AS geom
                FROM (
                    SELECT
                        text,
                        MAX(_text) AS _text,
                        MAX(text_tokenless) AS text_tokenless,
                        unnest(ST_ClusterWithin(geom, 0.01)) AS geom
                    FROM address
                    WHERE segment = ${segment}
                    GROUP BY text
                ) addr;
        `, (err, res) => {
            console.error(`ok - clustered addresses - seg: ${segment}`);

            return cb(err);
        });
    }

    /**
     * Cluster network lines within a given segment
     * @param {boolean} segment Segment ID to cluster within
     * @param {Function} cb Callback in (err, res)
     * @return {Function} Callback
     */
    network(segment = 1, cb) {
        this.pool.query(`
            BEGIN TRANSACTION;

            INSERT INTO network_cluster (text, _text, text_tokenless, geom, buffer)
                SELECT
                    netw.text,
                    netw._text,
                    netw.text_tokenless,
                    ST_Multi(ST_CollectionExtract(netw.geom, 2)) AS geom,
                    ST_Buffer(ST_Envelope(geom), 0.01) AS buffer
                FROM (
                    SELECT
                        text,
                        MAX(_text) AS _text,
                        MAX(text_tokenless) AS text_tokenless,
                        unnest(ST_ClusterWithin(geom, 0.01)) AS geom
                    FROM network
                    WHERE segment = ${segment}
                    GROUP BY text
                ) netw;


            -- extracts distinct Z coordinates from a multilinestring
            CREATE OR REPLACE FUNCTION get_source_ids(geometry(MultiLineStringZ))
            RETURNS BIGINT[]
            AS
            $$
            DECLARE
               mls ALIAS FOR $1;
               ls geometry(LineStringZ);
               retVal BIGINT[];
               j BIGINT;
            BEGIN
              j := 1;
              FOR ls IN SELECT (ST_Dump(mls)).geom LOOP
                FOR i IN 1..ST_NPoints(ls) LOOP
                  retVal[j] := ST_Z(ST_PointN(ls, i));
                  j := j + 1;
                END LOOP;
              END LOOP;
              retVal := ARRAY(SELECT DISTINCT UNNEST(retVal) ORDER BY 1);
            RETURN retVal;
            END;
            $$
            LANGUAGE plpgsql
               STABLE
            RETURNS NULL ON NULL INPUT;

            UPDATE network_cluster SET source_ids=get_source_ids(geom);

            ALTER TABLE network_cluster ADD COLUMN geom_flat geometry(geometry, 4326);

            UPDATE network_cluster SET geom_flat=ST_SetSRID(ST_Force2D(geom), 4326);

            ALTER TABLE network_cluster DROP COLUMN geom;

            ALTER TABLE network_cluster RENAME geom_flat TO geom;

            COMMIT;
        `, (err, res) => {
            console.error(`ok - clustered network - seg: ${segment}`);

            return cb(err);
        });
    }


    /**
    * Expands address_clusters with identically-named but unmatched nearby address clusters
    * @param {Function} cb Callback in (err, res)
    * @return {Function} cb
    **/
    adoption(cb) {
        this.pool.query(`
            BEGIN;

            ALTER TABLE network_cluster DROP COLUMN IF EXISTS address_text;
            ALTER TABLE network_cluster ADD COLUMN address_text TEXT;
            ALTER TABLE address_cluster ADD COLUMN name_uniqueness NUMERIC DEFAULT 0;

            CREATE INDEX address_cluster_text_idx ON address_cluster (_text);
            CREATE INDEX network_cluster_address_idx ON network_cluster (address);

            UPDATE network_cluster n
                SET address_text = a._text
                FROM address_cluster a
                WHERE n.address = a.id;

            CREATE TEMPORARY TABLE name_count ON COMMIT DROP AS SELECT _text, COUNT(id) AS cnt FROM address_cluster GROUP BY _text;
            CREATE INDEX name_cluster_text_idx ON name_count (_text);
            UPDATE address_cluster ac
                 SET name_uniqueness = nc.cnt
                 FROM name_count nc
                 WHERE ac._text=nc._text;

            ALTER TABLE address_cluster ADD COLUMN orphan_adoptive_parent BIGINT DEFAULT NULL;

            CREATE INDEX orphan_adoptive_parent_idx ON address_cluster (orphan_adoptive_parent);
            CREATE INDEX network_cluster_text_idx ON network_cluster (address_text);

            UPDATE address_cluster a
                SET orphan_adoptive_parent = n.address
                FROM network_cluster n
                WHERE
                    a.name_uniqueness > 1
                    AND
                    (
                        a.id = n.address
                        OR
                        (
                            a._text = n.address_text
                            AND ST_Intersects(n.buffer, a.geom)
                            AND a.id NOT IN (SELECT address FROM network_cluster WHERE address IS NOT NULL)
                        )
                    );

            CREATE TEMPORARY TABLE orphan_groups
                ON COMMIT DROP AS
                    SELECT
                        orphan_adoptive_parent,
                        ST_CollectionExtract(ST_Collect(geom),1) AS geom
                    FROM address_cluster
                    WHERE orphan_adoptive_parent IS NOT NULL
                    GROUP BY orphan_adoptive_parent;

            UPDATE address_cluster a
                SET geom = o.geom
                FROM orphan_groups o
                WHERE
                    o.orphan_adoptive_parent = a.id
                AND
                    o.orphan_adoptive_parent IS NOT NULL;

            DELETE FROM address_cluster
                WHERE
                    id IN (SELECT id FROM address_cluster WHERE orphan_adoptive_parent IS NOT NULL)
                AND
                    id NOT IN (SELECT address FROM network_cluster WHERE address IS NOT NULL);

            ALTER TABLE address_cluster DROP COLUMN orphan_adoptive_parent;

            COMMIT;
        `, cb)
    }

    /**
    * Prune network_cluster assignments where the address_cluster is assigned to more than one
    * @param {Function} cb Callback in (err, res)
    * @return {Function} cb
    **/
    prune(cb) {
        let that = this;
        this.pool.connect((err, client, pg_done) => {
            if (err) return cb(err);
            const cursor = client.query(new Cursor(`
                SELECT
                    a.id AS address_id,
                    a.text AS address_text,
                    a.text_tokenless AS address_text_tokenless,
                    n.id AS network_id,
                    n.text AS network_text,
                    n.text_tokenless AS network_text_tokenless
                FROM network_cluster n inner join address_cluster a ON n.address=a.id
                WHERE n.address IN
                    (SELECT address FROM network_cluster WHERE address IS NOT NULL GROUP BY address HAVING COUNT(address) > 1)
                ORDER BY a.id ASC;
            `));

            /**
             * Iterate through batch of potential matches to find the best single match
             * @param {Array} batch Array of batches to process
             * @param {Function} cb2 Callback in (err, res)
             * @return {Function} cb2
             */
            function pruneBatch(batch, cb2) {
                let bestMatch = null;
                for (let batchi = 0; batchi < batch.length; batchi++) {
                    let cur = batch[batchi];
                    let curDist;
                    if (cur.address_text_tokenless && cur.network_text_tokenless)
                        curDist = (0.25 * dist(cur.address_text, cur.network_text)) + (0.75 * dist(cur.address_text_tokenless, cur.network_text_tokenless));
                    else
                        curDist = dist(cur.address_text, cur.network_text);
                    if (!bestMatch || (curDist < bestMatch[0]))
                        bestMatch = [curDist, cur.network_id];
                }
                // return a list of all network_ids that are not the best match
                return cb2(null, batch.map((x) => { return x.network_id; }).filter((x) => { return x !== bestMatch[1]; }));
            }

            let batch = [];
            let q = Queue();

            iterate();

            /**
             * Iterative wrapper around pg_cursor to allow for better memory management of in-memory network_clusters being pruned
             */
            function iterate() {
                cursor.read(100, (err, rows) => {
                    if (!rows.length) {
                        if (batch.length)
                            q.defer(pruneBatch, batch);
                        q.awaitAll((err, results) => {
                            let deleteMe = results.reduce((prev, cur) => { return prev.concat(cur); }, []).join(',');
                            that.pool.query(`UPDATE network_cluster SET address=NULL WHERE id IN (${deleteMe});`, (err, res) => {
                            if (err) return cb(err);
                            pg_done();
                            return cb();
                            });
                        });
                    }
                    else {
                        rows.forEach((row) => {
                            if ((batch.length > 0) && (batch[batch.length - 1].address_id !== row.address_id)) {
                                q.defer(pruneBatch, batch.slice(0));
                                batch = [];
                            }
                            batch.push(row);
                        });

                        return iterate();
                    }
                });
            }
        });
    }

    /**
    * Collapse together duplicate network_clusters
    * @param {Function} callback Callback func (err, res)
    * @return {Function} callback
    **/
    collapse(callback) {
        let that = this;

        that.startTime = +(new Date());

        let collapseQ = Queue(1);
        collapseQ.defer(collapseDupes);
        //collapseQ.defer(collapseSubstantialOverlap);
        //collapseQ.defer(collapseStrongTextMatchWithOverlap);
        //collapseQ.defer(reassignMismatchedPoints);

        collapseQ.awaitAll((err, results) => {
            if (err)
                console.log(`not ok - error during cluster.collapse: ${err}`);
            else
                console.log(`ok - collapsed network clusters in ${Math.round(+(new Date()) - that.startTime)} ms`);
            return callback(err);
        });

        /**
        * collapse one or more network clusters and their address clusters
        * (if any) into a target network cluster & its address cluster
        * @param {number} collapseInto id of network_cluster to be expanded
        * @param {Array} otherClusters ids of network_clusters to be collapsed into collapseInto
        * @param {Function} cnCallback callback
        **/
        function collapseNetworkClusters(collapseInto, otherClusters, cnCallback) {
            that.pool.query(`
                BEGIN TRANSACTION;

                -- combine address cluster geometry; currently ignores text
                UPDATE address_cluster a1 SET
                    geom=a2.geom
                FROM (
                    SELECT
                        ST_CollectionExtract(ST_Collect(geom),1) AS geom
                    FROM
                        address_cluster
                    WHERE
                        id IN (
                            SELECT
                                address
                            FROM
                                network_cluster
                            WHERE
                                address IS NOT NULL
                            AND
                                id IN (${collapseInto},${otherClusters.join(',')})
                        )
                ) a2
                WHERE
                    a1.id=(SELECT address FROM network_cluster WHERE id=${collapseInto})
                AND
                    a1.id IS NOT NULL;

                -- delete the collapsed address clusters
                DELETE FROM
                    address_cluster a
                WHERE
                    id IN (
                        SELECT
                            address
                        FROM
                            network_cluster n
                        WHERE
                            id IN (${otherClusters.join(',')})
                    )
                AND
                    id IS NOT NULL;

                -- combine network cluster names
                UPDATE network_cluster n1 SET
                    _text=(CASE n1._text WHEN NULL THEN '' ELSE n1._text||',' END)||na._text,
                    "text"=(CASE n1."text" WHEN NULL THEN '' ELSE n1."text"||',' END)||na."text",
                    text_tokenless=(CASE n1.text_tokenless WHEN NULL THEN '' ELSE n1.text_tokenless||',' END)||na.text_tokenless
                FROM (
                    SELECT
                        STRING_AGG(n2._text, ',' ORDER BY n2.id ASC) AS _text,
                        STRING_AGG(n2."text", ',' ORDER BY n2.id ASC) AS "text",
                        STRING_AGG(n2.text_tokenless, ',' ORDER BY n2.id ASC) AS text_tokenless
                    FROM
                        network_cluster n2
                    WHERE n2.id IN (${otherClusters.join(',')})
                ) na
                WHERE
                    n1.id=${collapseInto};

                -- delete the extraneous network clusters
                DELETE FROM network_cluster WHERE id IN (${otherClusters.join(',')});

                COMMIT;
                `, cnCallback);
        }

        /**
        * first step of cluster.collapse -- eliminate network clusters
        * that have entirely identical source_id provenance
        * @param {Function} collapseDupesCallback callback
        **/
        function collapseDupes(collapseDupesCallback) {

            // setup accounting tables/columns -- can't use IF NOT EXISTS bc circle runs an old postgres version
            that.pool.query(`
                DO $$
                BEGIN
                    BEGIN
                        ALTER TABLE network_cluster ADD COLUMN point_count BIGINT;
                    EXCEPTION
                        WHEN duplicate_column THEN RAISE NOTICE 'column point_count already exists in network_cluster';
                    END;
                END;
                $$
            `, (err) => {
                if (err) return collapseDupesCallback(err);

                that.pool.query(`
                    UPDATE network_cluster n SET
                        point_count=acpc.total
                    FROM
                        (
                            SELECT
                                a.id AS id,
                                COUNT(a.id) AS total
                            FROM
                                (SELECT id, ST_Dump(geom) FROM address_cluster) a
                            GROUP BY a.id
                        ) acpc
                    WHERE
                        n.address IS NOT NULL
                    AND
                        acpc.id=n.address;

                    DROP TABLE IF EXISTS dupes;
                    CREATE TABLE dupes AS
                    SELECT
                        n1.id AS id,
                        MAX(n1._text) AS _text,
                        STRING_AGG(n2.id::text, ',' ORDER BY COALESCE(n2.point_count,0) DESC, n2.id ASC) AS contained_cluster_ids,
                        STRING_AGG(n2._text::text, ',' ORDER BY COALESCE(n2.point_count,0) DESC, n2.id ASC) AS contained_cluster_names,
                        STRING_AGG(COALESCE(n2.address,-1)::text, ',' ORDER BY COALESCE(n2.point_count,0) DESC, n2.id ASC) AS contained_cluster_address,
                        STRING_AGG(COALESCE(n2.point_count,0)::text, ',' ORDER BY COALESCE(n2.point_count,0) DESC, n2.id ASC) AS address_cluster_point_count
                    FROM
                        network_cluster n1 INNER JOIN network_cluster n2
                    ON
                        n1.source_ids = n2.source_ids
                    GROUP BY
                        n1.id
                    HAVING
                        COUNT(n2.id) > 1; -- otherwise we get a row for every cluster

                `, (err) => {
                    if (err) return collapseDupesCallback(err);

                    let q = Queue(10);
                    that.pool.connect((err, client, pg_done) => {
                        if (err) return collapseDupesCallback(err);
                        const cursor = client.query(new Cursor(`
                            SELECT
                                id,
                                _text,
                                contained_cluster_ids,
                                contained_cluster_names,
                                contained_cluster_address,
                                address_cluster_point_count
                            FROM dupes
                            ORDER BY id ASC;`));

                        let processedIds = [];

                        /**
                         * Iterative wrapper around pg_cursor to allow for better memory management of in-memory network_clusters being pruned
                         */
                        function collapseDupesIterate() {
                            cursor.read(100, (err, rows) => {
                                if (err) return collapseDupesCallback(err);
                                if (rows.length) {
                                    rows.forEach((row) => {
                                        let clusterIds = row.contained_cluster_ids
                                            .split(',')
                                            .map((x) => parseInt(x))
                                            .filter((x) => { return processedIds.indexOf(x) === -1; });
                                        if (clusterIds.length > 1) {
                                            for (let clusterId of clusterIds)
                                                processedIds.push(clusterId);
                                            let collapseInto = clusterIds.shift();
                                            q.defer(collapseNetworkClusters, collapseInto, clusterIds);
                                        }
                                    });

                                    return collapseDupesIterate();
                                }
                                else {
                                    q.awaitAll((err, results) => {
                                        if (err) return collapseDupesCallback(err);
                                        that.pool.query(`DROP TABLE dupes;`, (err, res) => {
                                            if (err) return cb(err);
                                            pg_done();
                                            return collapseDupesCallback();
                                        });
                                    });
                                }
                            });
                        }

                        collapseDupesIterate();
                    });
                });
            });
        }

        /**
        * second step of cluster.collapse -- eliminate network clusters
        * that have substantial but not 100% overlap by length
        * @param {Function} collapseOverlapCallback callback
        **/
        function collapseSubstantialOverlap(collapseOverlapCallback) {
            let networkLengths = {};

            that.pool.connect((err, client, pg_done) => {
                if (err) return collapseOverlapCallback(err);

                const lengthCursor = client.query(new Cursor(`SELECT id, network_length FROM network;`));

                function lengthIterate() {
                    lengthCursor.read(1000, (err, rows) => {
                        if (err) return collapseOverlapCallback(err);
                        if (!rows.length) {
                            pg_done();
                            return processOverlap();
                        }
                        else {
                            for (let row of rows)
                                networkLengths[row.id] = parseFloat(row.network_length);
                            return lengthIterate();
                        }
                    });
                }

                lengthIterate();
            });

            let processedIds = [];

            function processOverlap() {
                let q = Queue(10);
                that.pool.connect((err, client, pg_done) => {
                    if (err) return collapseOverlapCallback(err);
                    const processCursor = client.query(new Cursor(`
                        SELECT
                             n1.id AS id,
                             MAX(n1._text) AS _text,
                             STRING_AGG(n2.id::text, '|' ORDER BY n2.id ASC) AS cluster_ids,
                             STRING_AGG(n2.source_ids::text, '|' ORDER BY n2.id ASC) AS cluster_source_ids,
                             STRING_AGG(n2._text, '|' ORDER BY n2.id ASC) AS cluster_texts
                         FROM
                             network_cluster n1 INNER JOIN network_cluster n2
                         ON
                             n1.source_ids @> n2.source_ids
                         GROUP BY
                             n1.id
                         HAVING
                             COUNT(n2.id) > 1;
                    `));

                    function networkLength(networkIds) {
                        return networkIds.reduce((prev, cur) => {
                            return prev + (networkLengths[cur] || 0);
                        }, 0);
                    }

                    let processedIds = [];
                    function processOverlapIterate() {
                        processCursor.read(100, (err, rows) => {
                            if (err) return collapseOverlapCallback(err);
                            if (rows.length) {
                                for (let row of rows) {
                                    let cluster_ids = row.cluster_ids.split('|').map((x) => parseInt(x));
                                    let cluster_source_ids = row.cluster_source_ids
                                        .split('|')
                                        .map((x) => { return x.replace(/[\{\}]/g, '').split(',').map((y) => parseInt(y)) });
                                    let cluster_texts = row.cluster_texts.split('|');

                                    let clusters = [];
                                    for (let i = 0; i < cluster_ids.length; i++) {
                                        clusters.push({
                                            id: cluster_ids[i],
                                            source_ids: cluster_source_ids[i],
                                            _text: cluster_texts[i],
                                            network_length: networkLength(cluster_source_ids[i])
                                        });
                                    }

                                    // put longest cluster in first position
                                    clusters.sort((a, b) => {
                                        if (a.network_length > b.network_length)
                                            return -1;
                                        else if (a.network_length < b.network_length)
                                            return 1;
                                        return 0;
                                    });

                                    let parentCluster = clusters.shift();
                                    let collapseMe = [];

                                    for (let child of clusters) {
                                        child.overlapLength = networkLength(child.source_ids.filter((x) => { return parentCluster.source_ids.indexOf(x) !== -1; }));
                                        // merge if overlapping portion is >=95% of parent length
                                        if (((child.overlapLength / parentCluster.network_length) > 0.95) && (processedIds.indexOf(child.id) === -1)) {
                                            console.log(JSON.stringify(parentCluster));
                                            console.log('    ' + JSON.stringify(child));

                                            collapseMe.push(child.id);
                                            processedIds.push(child.id);
                                        }
                                    }
                                    if (collapseMe.length > 0)
                                        q.defer(collapseNetworkClusters, parentCluster.id, collapseMe);
                                }
                                return processOverlapIterate();
                            }
                            else {
                                q.awaitAll((err, results) => {
                                    pg_done();
                                    return collapseOverlapCallback(err);
                                });
                            }
                        });
                    }

                    processOverlapIterate();
                });
            }
        }


        // * clusters with a strong text match
        //            aaaaaaaaa              Main Street
        // bbbbbbbbbb bbbbbbbbb bbbbbbbbb    MAIN ST


        // * clusters where points span longer segment, name matches shorter segment
        // * addresses should be reassigned to the longer segment & the name added
        //        bbbbbbbbb                  Main st
        // aaaaaa aaaaaaaaa aaaaaaaaaaaaa    RT 50
        // B  B   BB   B    B     B   B B    Main st (addresses)
    }

    /**
    * Optimize cluster databases with Geometric indexes
    * @param {Function} cb Callback in (err, res)
    * @return {Function} cb
    */
    optimize(cb) {
        this.pool.query(`
            BEGIN;
            CREATE INDEX IF NOT EXISTS address_cluster_gix ON address_cluster USING GIST (geom);
            CREATE INDEX IF NOT EXISTS network_cluster_gix ON network_cluster USING GIST (geom);
            CLUSTER address_cluster USING address_cluster_gix;
            CLUSTER network_cluster USING network_cluster_gix;
            ANALYZE address_cluster;
            ANALYZE network_cluster;
            COMMIT;
        `, (err, res) => {
            return cb(err);
        });
    }

    /**
     * Attempt to autoname unnamed streets by using surrounding address points
     * @param {numeric} id ID of network to attempt to name
     * @param {Function} cb Callback in (err, res)
     * @return {Function} cb
     */
    name(id, cb) {
        this.pool.query(`SELECT ST_AsGeoJSON(geom) AS geom FROM network WHERE id = ${id}`, (err, res) => {
            if (err) return cb(err);

            let str = JSON.parse(res.rows[0].geom);

            let buff = buffer(str, 0.1).geometry;

            let names = {};

            this.pool.query(`SELECT text, text_tokenless, _text FROM address WHERE ST_Within(geom, ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(buff)}'), 4326))`, (err, res) => {
                if (err) return cb(err);

                for (let res_it = 0; res_it < res.rows.length; res_it++) {
                    let text = JSON.stringify([
                        res.rows[res_it].text,
                        res.rows[res_it].text_tokenless,
                        res.rows[res_it]._text
                    ]);

                    if (!names[text]) names[text] = 1;
                    else names[text]++;
                }

                let str = Object.keys(names);

                str.sort((a, b) => {
                    return names[b] - names[a];
                });

                if (!str.length) return cb();

                let text = JSON.parse(str[0]);

                this.pool.query(`
                    UPDATE
                        network
                    SET
                        text = '${text[0]}',
                        text_tokenless = '${text[1]}',
                        _text = '${text[2]}',
                        named = TRUE
                    WHERE
                        id = ${id}
                `, (err, res) => {
                    return cb(err);
                });
            });
        });
    }
}

module.exports = Cluster;
