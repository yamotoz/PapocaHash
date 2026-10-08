/// A closure monomorfizada permite ao compilador integrar o hash ao laço.
pub fn find<F: FnMut(&[u8]) -> bool>(block: &[u8], verify: F) -> Option<usize> {
    block.split(|&byte| byte == b'\n').filter(|word| !word.is_empty()).position(verify)
}

#[cfg(test)]
mod tests {
    use super::find;

    #[test]
    fn finds_boundaries_and_unicode() {
        assert_eq!(find(b"first\nsecond\nlast\n", |word| word == b"first"), Some(0));
        assert_eq!(find(b"first\nsecond\nlast\n", |word| word == b"last"), Some(2));
        assert_eq!(find("abc\nação🔷\nxyz\n".as_bytes(), |word| word == "ação🔷".as_bytes()), Some(1));
        assert_eq!(find(b"", |_| true), None);
    }

    #[test]
    fn exhausts_exactly_one_million() {
        let words = b"candidate\n".repeat(1_000_000);
        let mut count = 0;
        assert_eq!(
            find(&words, |_| {
                count += 1;
                false
            }),
            None
        );
        assert_eq!(count, 1_000_000);
    }

    #[test]
    fn stops_at_first_match() {
        let mut count = 0;
        assert_eq!(
            find(b"a\nb\nc\n", |word| {
                count += 1;
                word == b"b"
            }),
            Some(1)
        );
        assert_eq!(count, 2);
    }
}
