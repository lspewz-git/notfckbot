/** Russian counted nouns: some callers need just the form, others include the number. */
function pluralWord(n, one, few, many) {
    const tens = n % 100;
    const ones = n % 10;
    return tens >= 11 && tens <= 14 ? many : ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many;
}

const plural = (n, one, few, many) => `${n} ${pluralWord(n, one, few, many)}`;

module.exports = { pluralWord, plural };
