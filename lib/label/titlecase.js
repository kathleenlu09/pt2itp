/*eslint no-lonely-if: "off"*/ // <-- complying with this linting rule would reduce code readability

const wordBoundary = new RegExp("[\\s\\u2000-\\u206F\\u2E00-\\u2E7F\\\\!\"#$%&()*+,\\-.\\/:;<=>?@\\[\\]^_{|}~]+", 'g');
const allowedAfterSpace = new RegExp("[()#<>\\[\\]{}\"]+");
const diacritics = require('diacritics').remove;
const dist = require('fast-levenshtein').get

/**
 * Test if a string if fully uppercase
 * @param {string} x test input
 * @return {boolean}
 */
function isUpperCase(x) {
    return x.toUpperCase() === x;
}

/**
 * Number of times a string switches from lower to upper or upper to lower
 * @param {string} x String to test
 * @return {numeric}
 */
function numCaseChanges(x) {
    return x
        .split('')
        .filter((y) => { return /\w/.test(y); })
        .reduce((prev, cur, i, arr) => {
            if (i === 0) return 0;
            if (isUpperCase(cur) !== isUpperCase(arr[i-1]))
                return prev + 1;
            else
                return prev;
        }, 0);
}

/**
 * Title case a given string except for minors
 * @param {string} text Text to be titlecased
 * @param {Array} config Object containing @mapbox/title-case configuration
 */
function titleCase(text, config) {
    config.minors = config.minors || [];
    config.pre = config.pre || [];
    config.post = config.post || [];
    let separators = [];
    for (let separator = wordBoundary.exec(text); !!separator; separator = wordBoundary.exec(text)) {
        // preserve the characters separating words, collapsing runs of whitespace but preserving other stuff
        let sep = '';
        for (let sep_i = 0; sep_i < separator[0].length; sep_i++) {
            let lastCharIsSpace = (sep_i > 0) && (sep[sep.length - 1] === ' ');
            if (!(/\s/.test(separator[0][sep_i]))) {
                // don't add separators at the beginning of words (after spaces)
                if (!lastCharIsSpace || allowedAfterSpace.test(separator[0][sep_i]))
                    sep += separator[0][sep_i];
            }
            else if (!lastCharIsSpace) {
                sep += ' ';
            }
        }
        separators.push(sep);
    }
    text = config.pre.reduce((prev, cur) => { return cur(prev); }, text);
    text = text
        .split(wordBoundary)
        .map((y) => { return y.toLowerCase(); })
        .reduce((prev, cur, i) => {
            if (i > 0)
                prev.push(separators[i-1]);
            if (cur.length > 0) {
                if (config.minors.indexOf(cur) !== -1)
                    prev.push(cur);
                else
                    prev.push(cur[0].toUpperCase() + cur.slice(1));
            }
            return prev;
        }, [])
        .join('');
    return config.post.reduce((prev, cur) => { return cur(prev); }, text);
}

module.exports = (opts) => {
    opts = opts || {};

    let titleCaseConfig;
    if (opts.language && (opts.language !== 'en'))
        throw new Error('only en titlecase minors are currently supported');
    else
        titleCaseConfig = require('@mapbox/title-case')(opts.language);

    let synonym = !!opts.synonym;

    return (feature) => {
        let text, other;
        if (opts.favor && (opts.favor === 'network')) {
            text = feature.network_text;
            other = feature.address_text;
        }
        else {
            text = feature.address_text;
            other = feature.network_text;
        }

        if (text) text = text.trim();
        if (other) other = other.trim();

        if (!text) {
            text = other;
        }
        else {
            // shortcircuit if network & address text agree
            // return the one with more case changes, which presumably means more case information
            if (other && diacritics(text).toLowerCase().trim() === diacritics(other).toLowerCase().trim()) {
                if (numCaseChanges(text) >= numCaseChanges(other))
                    return text;
                else
                    return other;
            }
        }

        // otherwise, apply title case
        if (synonym && (diacritics(text) !== diacritics(other)))
            return titleCase(text, titleCaseConfig) + ',' + titleCase(other, titleCaseConfig);
        else
            return titleCase(text, titleCaseConfig);
    };
};

module.exports.titleCase = titleCase;
