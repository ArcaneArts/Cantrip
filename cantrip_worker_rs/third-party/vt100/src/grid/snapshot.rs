use super::{Grid, Pos};
use crate::{
    attrs::Attrs,
    row::Row,
    term::{BufWrite as _, ClearAttrs, ClearScreen, EraseChar, MoveTo},
};

impl Grid {
    pub(crate) fn history_rows(&self) -> usize {
        self.scrollback.len()
    }

    pub(crate) fn write_snapshot(
        &self,
        bytes: &mut Vec<u8>,
        history: usize,
        limit: usize,
    ) -> Option<Attrs> {
        ClearAttrs.write_buf(bytes);
        ClearScreen.write_buf(bytes);
        if self.scrollback_len > 0 {
            bytes.extend_from_slice(b"\x1b[3J");
        }

        let mut attrs = Attrs::default();
        let mut cursor = Pos::default();
        let mut previous: Option<&Row> = None;
        let rows = self
            .scrollback
            .iter()
            .skip(self.scrollback.len() - history)
            .chain(self.drawing_rows());
        for (index, row) in rows.enumerate() {
            let y = index.min(usize::from(self.size.rows - 1)) as u16;
            if let Some(prior) = previous {
                if prior.wrapped() {
                    (cursor, attrs) = wrapped_start(
                        bytes,
                        self.size.cols,
                        y,
                        cursor.col,
                        attrs,
                        prior,
                        row,
                    );
                } else {
                    Attrs::default().write_escape_code_diff(bytes, &attrs);
                    bytes.extend_from_slice(b"\r\n");
                    cursor = Pos { row: y, col: 0 };
                    attrs = Attrs::default();
                }
            }
            if cursor.col < self.size.cols {
                (cursor, attrs) = row.write_contents_formatted(
                    bytes,
                    cursor.col,
                    self.size.cols - cursor.col,
                    y,
                    false,
                    Some(cursor),
                    Some(attrs),
                );
            }
            if bytes.len() > limit {
                return None;
            }
            previous = Some(row);
        }
        self.write_cursor_position_formatted(bytes, Some(cursor), Some(attrs));
        (bytes.len() <= limit).then_some(attrs)
    }
}

fn wrapped_start(
    bytes: &mut Vec<u8>,
    cols: u16,
    row: u16,
    previous_col: u16,
    mut attrs: Attrs,
    previous: &Row,
    next: &Row,
) -> (Pos, Attrs) {
    let first = next.get(0).unwrap();
    let width = if first.is_wide() { 2 } else { 1 };
    let plain = Attrs::default();
    if first.has_contents() && previous_col + width > cols {
        let first_attrs = *first.attrs();
        first_attrs.write_escape_code_diff(bytes, &attrs);
        bytes.extend_from_slice(first.contents().as_bytes());
        if width < cols && first_attrs.bgcolor() != plain.bgcolor() {
            // With background-color erase, a scroll can fill the new row
            // with the first cell's background. Restore blank cells before
            // applying the remainder of the recorded row.
            plain.write_escape_code_diff(bytes, &first_attrs);
            EraseChar::new(cols - width).write_buf(bytes);
            attrs = plain;
        } else {
            attrs = first_attrs;
        }
        return (Pos { row, col: width }, attrs);
    }

    // A cursor move does not produce a soft wrap. Fill any empty cells at the
    // right edge and print one temporary cell on the following row, then
    // erase the temporary cells while the two rows are addressable.
    plain.write_escape_code_diff(bytes, &attrs);
    let missing = cols - previous_col;
    bytes.resize(bytes.len() + usize::from(missing) + 1, b' ');
    let start = Pos { row, col: 0 };
    MoveTo::new(start).write_buf(bytes);
    EraseChar::new(1).write_buf(bytes);
    if missing > 0 && row > 0 {
        let tail = Pos {
            row: row - 1,
            col: previous_col,
        };
        MoveTo::new(tail).write_buf(bytes);
        EraseChar::new(missing).write_buf(bytes);
        let (_, attrs) = previous.write_contents_formatted(
            bytes,
            tail.col,
            missing,
            tail.row,
            false,
            Some(tail),
            Some(plain),
        );
        plain.write_escape_code_diff(bytes, &attrs);
        MoveTo::new(start).write_buf(bytes);
    }
    (start, plain)
}
