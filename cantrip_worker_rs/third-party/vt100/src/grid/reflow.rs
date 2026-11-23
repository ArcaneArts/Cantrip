use super::{Grid, Pos, Size};
use crate::{row::Row, Cell};
use std::collections::VecDeque;

impl Grid {
    pub(crate) fn reflow(&mut self, size: Size) {
        if size == self.size {
            return;
        }
        let width = size.cols;
        let height = usize::from(size.rows);
        let old_height = usize::from(self.size.rows);
        let mut base = self.scrollback.len();
        let cursor = base + usize::from(self.pos.row);
        let saved = self.saved_row;
        let mut source = std::mem::take(&mut self.scrollback);
        source.extend(std::mem::take(&mut self.rows));
        if height > old_height && self.pos.row == self.size.rows - 1 {
            base = base.saturating_sub(height - old_height);
        } else if height < old_height {
            base = base.max((cursor + 1).saturating_sub(height));
        }
        source.resize_with(base + height, || Row::new(self.size.cols));
        let cursor_y = cursor - base;

        let (mut rows, mut base, cursor, saved) = if width == self.size.cols {
            (source, base, cursor, saved)
        } else {
            let source = source.make_contiguous();
            let mut rows = Layout::new(self.scrollback_len + height);
            let mut start = 0;
            let mut mapped_cursor = cursor;
            let mut mapped_saved = None;
            let mut new_base = base;
            while start < source.len() && rows.count < rows.end {
                let end = (start..source.len())
                    .find(|&index| !source[index].wrapped())
                    .map_or(source.len(), |index| index + 1);
                if (start..end).contains(&cursor) {
                    // xterm leaves the group under the cursor for the application
                    // to redraw. The rows above and below it still reflow.
                    mapped_cursor = rows.count + cursor - start;
                    new_base = if base == 0 {
                        (mapped_cursor + 1).saturating_sub(height)
                    } else {
                        mapped_cursor.saturating_sub(cursor_y)
                    };
                    rows.end = new_base + height;
                    if (start..end).contains(&saved) {
                        mapped_saved = Some(rows.count + saved - start);
                    }
                    for source_row in &source[start..end] {
                        let mut row = source_row.clone();
                        row.resize(width, Cell::new());
                        row.wrap(source_row.wrapped());
                        rows.push(row);
                    }
                } else {
                    let saved_offset =
                        (start..end).contains(&saved).then(|| saved - start);
                    if let Some(row) =
                        rows.rewrap(&source[start..end], width, saved_offset)
                    {
                        mapped_saved = Some(row);
                    }
                }
                start = end;
            }
            (
                rows.rows,
                new_base.saturating_sub(rows.evicted),
                mapped_cursor.saturating_sub(rows.evicted),
                mapped_saved
                    .unwrap_or(rows.count.saturating_sub(1))
                    .saturating_sub(rows.evicted),
            )
        };

        // Height changes and reflow both keep the same history limit.
        let extra = base.saturating_sub(self.scrollback_len);
        rows.drain(..extra);
        base -= extra;
        self.rows = rows.split_off(base).into();
        self.rows.resize_with(height, || Row::new(width));
        self.scrollback = rows;
        self.scrollback_offset = 0;
        self.size = size;
        self.scroll_top = 0;
        self.scroll_bottom = size.rows - 1;
        let y = |index: usize| {
            (index.saturating_sub(extra + base)).min(height - 1) as u16
        };
        self.pos = Pos {
            row: y(cursor),
            col: self.pos.col.min(width - 1),
        };
        self.saved_row = saved.saturating_sub(extra).min(base + height - 1);
        self.saved_col = self.saved_col.min(width - 1);
    }
}

struct Layout {
    rows: VecDeque<Row>,
    limit: usize,
    count: usize,
    evicted: usize,
    end: usize,
}

impl Layout {
    fn new(limit: usize) -> Self {
        Self {
            rows: VecDeque::new(),
            limit,
            count: 0,
            evicted: 0,
            end: usize::MAX,
        }
    }

    fn push(&mut self, row: Row) {
        if self.count == self.end {
            return;
        }
        if self.rows.len() == self.limit {
            self.rows.pop_front();
            self.evicted += 1;
        }
        self.rows.push_back(row);
        self.count += 1;
    }

    fn rewrap(
        &mut self,
        group: &[Row],
        width: u16,
        saved: Option<usize>,
    ) -> Option<usize> {
        let mut row = Row::new(width);
        let mut col = 0;
        let mut mapped = None;
        for (index, source) in group.iter().enumerate() {
            if saved == Some(index) {
                mapped = Some(self.count + usize::from(col == width));
            }
            let last = index + 1 == group.len();
            let mut len = if last {
                source.occupied_columns()
            } else {
                source.cols()
            };
            if !last
                && source.get(len - 1).is_some_and(|cell| *cell == Cell::new())
                && group[index + 1].get(0).is_some_and(Cell::is_wide)
            {
                // The old wrap left one empty column before a wide character.
                len -= 1;
            }
            let mut source_col = 0;
            while source_col < len && self.count < self.end {
                let cell = source.get(source_col).unwrap();
                let cells = if cell.is_wide() { 2 } else { 1 };
                if cells > width {
                    source_col += cells;
                    continue;
                }
                if col + cells > width {
                    row.wrap(true);
                    self.push(row);
                    row = Row::new(width);
                    col = 0;
                }
                for offset in 0..cells {
                    *row.get_mut(col + offset).unwrap() =
                        source.get(source_col + offset).unwrap().clone();
                }
                source_col += cells;
                col += cells;
            }
        }
        self.push(row);
        mapped
    }
}
