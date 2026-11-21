const ASCII: u8 = b'B';
const DESIGNATE: &[u8; 4] = b"()*+";
const SELECT: [&[u8]; 4] = [b"\x0f", b"\x0e", b"\x1bn", b"\x1bo"];

#[derive(Clone, Debug)]
pub(crate) struct Charsets {
    designated: [u8; 4],
    slot: usize,
    active: u8,
    saved: [u8; 2],
}

impl Default for Charsets {
    fn default() -> Self {
        Self {
            designated: [ASCII; 4],
            slot: 0,
            active: ASCII,
            saved: [ASCII; 2],
        }
    }
}

impl Charsets {
    pub(crate) fn shift(&mut self, slot: usize) {
        self.slot = slot;
        self.active = self.designated[slot];
    }

    fn designate(&mut self, slot: usize, set: u8) {
        self.designated[slot] = set;
        if self.slot == slot {
            self.active = set;
        }
    }

    pub(crate) fn escape(&mut self, intermediates: &[u8], byte: u8) -> bool {
        match (intermediates, byte) {
            ([], b'~') => self.shift(1),
            ([], b'n' | b'}') => self.shift(2),
            ([], b'o' | b'|') => self.shift(3),
            ([b'%'], b'@' | b'G') => {
                self.shift(0);
                self.designate(0, ASCII);
            }
            ([prefix], set)
                if matches!(
                    set,
                    b'0' | b'A'
                        | b'B'
                        | b'4'
                        | b'C'
                        | b'5'
                        | b'R'
                        | b'Q'
                        | b'K'
                        | b'Y'
                        | b'E'
                        | b'6'
                        | b'Z'
                        | b'H'
                        | b'7'
                        | b'='
                ) =>
            {
                let slot = match prefix {
                    b'(' => 0,
                    b')' | b'-' => 1,
                    b'*' | b'.' => 2,
                    b'+' => 3,
                    _ => return false,
                };
                self.designate(slot, set);
            }
            _ => return false,
        }
        true
    }

    pub(crate) fn save(&mut self, alternate: bool) {
        self.saved[usize::from(alternate)] = self.active;
    }

    pub(crate) fn restore(&mut self, alternate: bool) {
        self.active = self.saved[usize::from(alternate)];
    }

    pub(crate) fn translate(&self, c: char) -> char {
        if self.active == b'0' && ('\x60'..='~').contains(&c) {
            return DEC_GRAPHICS[c as usize - 0x60];
        }
        let replacements = match self.active {
            b'A' => BRITISH,
            b'4' => DUTCH,
            b'C' | b'5' => FINNISH,
            b'R' => FRENCH,
            b'Q' => FRENCH_CANADIAN,
            b'K' => GERMAN,
            b'Y' => ITALIAN,
            b'E' | b'6' => NORWEGIAN_DANISH,
            b'Z' => SPANISH,
            b'H' | b'7' => SWEDISH,
            b'=' => SWISS,
            _ => return c,
        };
        replacements
            .iter()
            .find_map(|&(source, translated)| {
                (c == source).then_some(translated)
            })
            .unwrap_or(c)
    }

    pub(crate) fn formatted(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (slot, &prefix) in DESIGNATE.iter().enumerate() {
            let set = if slot == self.slot {
                self.active
            } else {
                self.designated[slot]
            };
            if set != ASCII {
                bytes.extend_from_slice(&[0x1b, prefix, set]);
            }
        }
        if self.slot != 0 {
            bytes.extend_from_slice(SELECT[self.slot]);
        }
        bytes
    }
}

// DEC Special Graphics and the national replacement character sets used by
// xterm.js. The DEC entries are in printable ASCII order from 0x60 to 0x7e.
const DEC_GRAPHICS: [char; 31] = [
    '◆', '▒', '␉', '␌', '␍', '␊', '°', '±', '␤', '␋', '┘', '┐', '┌', '└', '┼',
    '⎺', '⎻', '─', '⎼', '⎽', '├', '┤', '┴', '┬', '│', '≤', '≥', 'π', '≠', '£',
    '·',
];
const BRITISH: &[(char, char)] = &[('#', '£')];
const DUTCH: &[(char, char)] = &[
    ('#', '£'),
    ('@', '¾'),
    ('[', 'i'),
    ('\\', '½'),
    (']', '|'),
    ('{', '¨'),
    ('|', 'f'),
    ('}', '¼'),
    ('~', '´'),
];
const FINNISH: &[(char, char)] = &[
    ('[', 'Ä'),
    ('\\', 'Ö'),
    (']', 'Å'),
    ('^', 'Ü'),
    ('\x60', 'é'),
    ('{', 'ä'),
    ('|', 'ö'),
    ('}', 'å'),
    ('~', 'ü'),
];
const FRENCH: &[(char, char)] = &[
    ('#', '£'),
    ('@', 'à'),
    ('[', '°'),
    ('\\', 'ç'),
    (']', '§'),
    ('{', 'é'),
    ('|', 'ù'),
    ('}', 'è'),
    ('~', '¨'),
];
const FRENCH_CANADIAN: &[(char, char)] = &[
    ('@', 'à'),
    ('[', 'â'),
    ('\\', 'ç'),
    (']', 'ê'),
    ('^', 'î'),
    ('\x60', 'ô'),
    ('{', 'é'),
    ('|', 'ù'),
    ('}', 'è'),
    ('~', 'û'),
];
const GERMAN: &[(char, char)] = &[
    ('@', '§'),
    ('[', 'Ä'),
    ('\\', 'Ö'),
    (']', 'Ü'),
    ('{', 'ä'),
    ('|', 'ö'),
    ('}', 'ü'),
    ('~', 'ß'),
];
const ITALIAN: &[(char, char)] = &[
    ('#', '£'),
    ('@', '§'),
    ('[', '°'),
    ('\\', 'ç'),
    (']', 'é'),
    ('\x60', 'ù'),
    ('{', 'à'),
    ('|', 'ò'),
    ('}', 'è'),
    ('~', 'ì'),
];
const NORWEGIAN_DANISH: &[(char, char)] = &[
    ('@', 'Ä'),
    ('[', 'Æ'),
    ('\\', 'Ø'),
    (']', 'Å'),
    ('^', 'Ü'),
    ('\x60', 'ä'),
    ('{', 'æ'),
    ('|', 'ø'),
    ('}', 'å'),
    ('~', 'ü'),
];
const SPANISH: &[(char, char)] = &[
    ('#', '£'),
    ('@', '§'),
    ('[', '¡'),
    ('\\', 'Ñ'),
    (']', '¿'),
    ('{', '°'),
    ('|', 'ñ'),
    ('}', 'ç'),
];
const SWEDISH: &[(char, char)] = &[
    ('@', 'É'),
    ('[', 'Ä'),
    ('\\', 'Ö'),
    (']', 'Å'),
    ('^', 'Ü'),
    ('\x60', 'é'),
    ('{', 'ä'),
    ('|', 'ö'),
    ('}', 'å'),
    ('~', 'ü'),
];
const SWISS: &[(char, char)] = &[
    ('#', 'ù'),
    ('@', 'à'),
    ('[', 'é'),
    ('\\', 'ç'),
    (']', 'ê'),
    ('^', 'î'),
    ('_', 'è'),
    ('\x60', 'ô'),
    ('{', 'ä'),
    ('|', 'ö'),
    ('}', 'ü'),
    ('~', 'û'),
];
