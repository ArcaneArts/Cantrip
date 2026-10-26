pub(crate) fn whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(crate) fn trim(value: &str) -> &str {
    value.trim_matches(whitespace)
}
pub(crate) fn length(value: &str) -> usize {
    value.encode_utf16().count()
}
