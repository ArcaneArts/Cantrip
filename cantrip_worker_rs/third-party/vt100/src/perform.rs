const BASE64: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const CLIPBOARD_SELECTOR: &[u8] = b"cpqs01234567";

pub struct WrappedScreen<CB: crate::callbacks::Callbacks = ()> {
    pub screen: crate::screen::Screen,
    pub callbacks: CB,
    preceding_width: u16,
}

impl WrappedScreen<()> {
    pub fn new(rows: u16, cols: u16, scrollback_len: usize) -> Self {
        Self::new_with_callbacks(rows, cols, scrollback_len, ())
    }
}

impl<CB: crate::callbacks::Callbacks> WrappedScreen<CB> {
    pub fn new_with_callbacks(
        rows: u16,
        cols: u16,
        scrollback_len: usize,
        callbacks: CB,
    ) -> Self {
        Self {
            screen: crate::screen::Screen::new(
                crate::grid::Size { rows, cols },
                scrollback_len,
            ),
            callbacks,
            preceding_width: 0,
        }
    }
}

impl<CB: crate::callbacks::Callbacks> vte::Perform for WrappedScreen<CB> {
    fn print(&mut self, c: char) {
        if c == '\u{fffd}' || ('\u{80}'..'\u{a0}').contains(&c) {
            self.preceding_width = 0;
            self.callbacks.unhandled_char(&mut self.screen, c);
        } else {
            let width = self.screen.text(self.screen.charsets.translate(c));
            if width != 0 {
                self.preceding_width = width;
            }
        }
    }

    fn execute(&mut self, b: u8) {
        self.preceding_width = 0;
        match b {
            7 => self.callbacks.audible_bell(&mut self.screen),
            8 => self.screen.bs(),
            9 => self.screen.tab(1, false),
            10..=12 => self.screen.lf(),
            13 => self.screen.cr(),
            14 => self.screen.charsets.shift(1),
            15 => self.screen.charsets.shift(0),
            _ => self.callbacks.unhandled_control(&mut self.screen, b),
        }
    }

    fn hook(&mut self, _: &vte::Params, _: &[u8], _: bool, _: char) {
        self.preceding_width = 0;
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, b: u8) {
        self.preceding_width = 0;
        if !ignore && self.screen.charsets.escape(intermediates, b) {
            return;
        }
        if let Some(i) = intermediates.first() {
            self.callbacks.unhandled_escape(
                &mut self.screen,
                Some(*i),
                intermediates.get(1).copied(),
                b,
            );
        } else {
            match b {
                b'7' => self.screen.decsc(),
                b'8' => self.screen.decrc(),
                b'=' => self.screen.deckpam(),
                b'>' => self.screen.deckpnm(),
                b'D' => self.screen.index(),
                b'E' => {
                    self.screen.cr();
                    self.screen.index();
                }
                b'H' => self.screen.set_tab_stop(),
                b'M' => self.screen.ri(),
                b'c' => self.screen.ris(),
                b'g' => self.callbacks.visual_bell(&mut self.screen),
                _ => {
                    self.callbacks.unhandled_escape(
                        &mut self.screen,
                        None,
                        None,
                        b,
                    );
                }
            }
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        ignore: bool,
        c: char,
    ) {
        let preceding_width = std::mem::take(&mut self.preceding_width);
        let mut unhandled = |screen: &mut crate::screen::Screen| {
            self.callbacks.unhandled_csi(
                screen,
                intermediates.first().copied(),
                intermediates.get(1).copied(),
                &params.iter().collect::<Vec<_>>(),
                c,
            );
        };
        match intermediates.first() {
            None => match c {
                '@' => self.screen.ich(canonicalize_params_1(params, 1)),
                'A' => self.screen.cuu(canonicalize_params_1(params, 1)),
                'B' => self.screen.cud(canonicalize_params_1(params, 1)),
                'C' | 'a' => self.screen.cuf(canonicalize_params_1(params, 1)),
                'D' => self.screen.cub(canonicalize_params_1(params, 1)),
                'E' => self.screen.cnl(canonicalize_params_1(params, 1)),
                'F' => self.screen.cpl(canonicalize_params_1(params, 1)),
                'G' | '`' => self.screen.cha(canonicalize_params_1(params, 1)),
                'H' | 'f' => self.screen.cup(canonicalize_params_2(params, 1, 1)),
                'I' => self.screen.tab(canonicalize_params_1(params, 1), false),
                'J' => self
                    .screen
                    .ed(canonicalize_params_1(params, 0), unhandled),
                'K' => self
                    .screen
                    .el(canonicalize_params_1(params, 0), unhandled),
                'L' => self.screen.il(canonicalize_params_1(params, 1)),
                'M' => self.screen.dl(canonicalize_params_1(params, 1)),
                'P' => self.screen.dch(canonicalize_params_1(params, 1)),
                'S' => self.screen.su(canonicalize_params_1(params, 1)),
                'T' => self.screen.sd(canonicalize_params_1(params, 1)),
                'X' => self.screen.ech(canonicalize_params_1(params, 1)),
                'Z' => self.screen.tab(canonicalize_params_1(params, 1), true),
                'b' => {
                    if !ignore && preceding_width != 0 {
                        self.screen.repeat_preceding_graphic(
                            preceding_width,
                            canonicalize_params_1(params, 1),
                        );
                    }
                }
                'd' => self.screen.vpa(canonicalize_params_1(params, 1)),
                'e' => self.screen.vpr(canonicalize_params_1(params, 1)),
                'g' => self
                    .screen
                    .clear_tab_stops(canonicalize_params_1(params, 0)),
                'h' | 'l' if !ignore => {
                    let mut handled = false;
                    for param in params {
                        if let Some(&mode) = param.first() {
                            handled |= self.screen.set_ansi_mode(mode, c == 'h');
                        }
                    }
                    if !handled {
                        unhandled(&mut self.screen);
                    }
                }
                'm' => self.screen.sgr(params, unhandled),
                's' => self.screen.decsc(),
                'u' => self.screen.decrc(),
                'r' => self.screen.decstbm(canonicalize_params_decstbm(
                    params,
                    self.screen.grid().size(),
                )),
                't' => {
                    let mut params_iter = params.iter();
                    let op =
                        params_iter.next().and_then(|x| x.first().copied());
                    if op == Some(8) {
                        let (screen_rows, screen_cols) = self.screen.size();
                        let rows =
                            params_iter.next().map_or(screen_rows, |x| {
                                *x.first().unwrap_or(&screen_rows)
                            });
                        let cols =
                            params_iter.next().map_or(screen_cols, |x| {
                                *x.first().unwrap_or(&screen_cols)
                            });
                        self.callbacks.resize(&mut self.screen, (rows, cols));
                    } else {
                        self.callbacks.unhandled_csi(
                            &mut self.screen,
                            None,
                            None,
                            &params.iter().collect::<Vec<_>>(),
                            c,
                        );
                    }
                }
                _ => {
                    self.callbacks.unhandled_csi(
                        &mut self.screen,
                        None,
                        None,
                        &params.iter().collect::<Vec<_>>(),
                        c,
                    );
                }
            },
            Some(b'!') if c == 'p' => self.screen.soft_reset(),
            Some(b'?') => match c {
                'J' => self
                    .screen
                    .decsed(canonicalize_params_1(params, 0), unhandled),
                'K' => self
                    .screen
                    .decsel(canonicalize_params_1(params, 0), unhandled),
                'h' => self.screen.decset(params, unhandled),
                'l' => self.screen.decrst(params, unhandled),
                _ => {
                    self.callbacks.unhandled_csi(
                        &mut self.screen,
                        Some(b'?'),
                        intermediates.get(1).copied(),
                        &params.iter().collect::<Vec<_>>(),
                        c,
                    );
                }
            },
            Some(i) => {
                self.callbacks.unhandled_csi(
                    &mut self.screen,
                    Some(*i),
                    intermediates.get(1).copied(),
                    &params.iter().collect::<Vec<_>>(),
                    c,
                );
            }
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bel_terminated: bool) {
        self.preceding_width = 0;
        match params {
            [b"0", s] => {
                self.callbacks.set_window_icon_name(&mut self.screen, s);
                self.callbacks.set_window_title(&mut self.screen, s);
            }
            [b"1", s] => {
                self.callbacks.set_window_icon_name(&mut self.screen, s);
            }
            [b"2", s] => {
                self.callbacks.set_window_title(&mut self.screen, s);
            }
            [b"8", parameters, first, rest @ ..] => {
                // Semicolons can appear in the destination. Store only the
                // visible link underline used by canonical snapshot replay.
                if !first.is_empty() || !rest.is_empty() {
                    self.screen.set_hyperlink(true);
                } else if std::str::from_utf8(parameters)
                    .is_ok_and(|p| p.trim().is_empty())
                {
                    self.screen.set_hyperlink(false);
                }
            }
            [b"52", ty, data] => {
                match (
                    ty.iter().all(|c| CLIPBOARD_SELECTOR.contains(c)),
                    *data,
                ) {
                    (true, b"?") => {
                        self.callbacks
                            .paste_from_clipboard(&mut self.screen, ty);
                    }
                    (true, data)
                        if data.iter().all(|c| BASE64.contains(c)) =>
                    {
                        self.callbacks.copy_to_clipboard(
                            &mut self.screen,
                            ty,
                            data,
                        );
                    }
                    _ => {
                        self.callbacks
                            .unhandled_osc(&mut self.screen, params);
                    }
                }
            }
            _ => {
                self.callbacks.unhandled_osc(&mut self.screen, params);
            }
        }
    }
}

fn canonicalize_params_1(params: &vte::Params, default: u16) -> u16 {
    let first = params.iter().next().map_or(0, |x| *x.first().unwrap_or(&0));
    if first == 0 {
        default
    } else {
        first
    }
}

fn canonicalize_params_2(
    params: &vte::Params,
    default1: u16,
    default2: u16,
) -> (u16, u16) {
    let mut iter = params.iter();
    let first = iter.next().map_or(0, |x| *x.first().unwrap_or(&0));
    let first = if first == 0 { default1 } else { first };

    let second = iter.next().map_or(0, |x| *x.first().unwrap_or(&0));
    let second = if second == 0 { default2 } else { second };

    (first, second)
}

fn canonicalize_params_decstbm(
    params: &vte::Params,
    size: crate::grid::Size,
) -> (u16, u16) {
    let mut iter = params.iter();
    let top = iter.next().map_or(0, |x| *x.first().unwrap_or(&0));
    let top = if top == 0 { 1 } else { top };

    let bottom = iter.next().map_or(0, |x| *x.first().unwrap_or(&0));
    let bottom = if bottom == 0 { size.rows } else { bottom };

    (top, bottom)
}
