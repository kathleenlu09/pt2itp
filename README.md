# Pts => Interpolation

[![Coverage Status](https://coveralls.io/repos/github/ingalls/pt2itp/badge.svg?branch=master)](https://coveralls.io/github/ingalls/pt2itp?branch=master)
[![Circle CI](https://circleci.com/gh/ingalls/pt2itp/tree/master.svg?style=shield)](https://circleci.com/gh/ingalls/pt2itp/tree/master)
[![David DM](https://david-dm.org/ingalls/pt2itp.svg)](https://david-dm.org/ingalls/pt2itp)

[![NPM](https://nodei.co/npm/pt2itp.png?downloads=true&downloadRank=true)](https://www.npmjs.com/package/pt2itp)

Given a road network and a set of address points as line delimited geojson; output an interpolation network.

## Input Data

### Address Input

Input line-delimited geojson features of points. Each point should have a property called `street` containing the street name
and `number` containing the street address.

Note: pt2itp is designed to be run on numberic address points. Unit numbers should be stripped out before being fed into pt2itp. Alternatively they
can be stripped using a map file. Examples of bad addresses and their correct counterparts include: `16A => 16` (US Unit #), `1/3 => 3` (NZ Unit #), `12-4 => 12`, etc
If non-numeric input is detected in addresses, a fatal error will be thrown.

#### Example

```
{ "type": "Feature", "geometry": { "type": "Point", ... }, "properties": { "street": "Main Street", "number": 10 } }
{ "type": "Feature", "geometry": { "type": "Point", ... }, "properties": { "street": "Main Street", "number": 11 } }
...
```

### Street Network Input

Input line-delimited geojson features of lines. Each line should have a property called `street` containing the street name.

#### Example

```
{ "type": "Feature", "geometry": { "type": "LineString", ... }, "properties": { "street": "Main Street" } }
{ "type": "Feature", "geometry": { "type": "LineString", ... }, "properties": { "street": "Main Street" } }
...
```

## Generating Interpolation Network

```
./index.js map --in-network=<FILE.geojson> --in-address=<File.geojson> --output=<File.geojson> --tokens=./lib/tokens/en.json"
```

## Version Numbers

PT2ITP follows the [Semver](http://semver.org/) spec for it's **CLI interface**.

This means that breaking changes to the CLI tools will result in a `MAJOR` release.
New features will result in a `MINOR` release and bug fixes a `PATCH`.

Internal functions may change in breaking ways with a `MINOR` release so long as they
don't change/break the CLI interface.
