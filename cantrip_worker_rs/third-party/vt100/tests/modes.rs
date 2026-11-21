#[test]
fn printing_respects_insert_and_autowrap_modes() {
    let mut parser = vt100::Parser::new(3, 5, 0);
    parser.process(b"abcdef\x1b[1;2H\x1b[4hXY\x1b[4lZ");
    assert_eq!(parser.screen().contents(), "aXYZcf");
    assert!(parser.screen().row_wrapped(0));
    parser.process("\x1b[3;1H\x1b[?7l123456界".as_bytes());
    assert_eq!(parser.screen().contents(), "aXYZcf\n12346");
    assert_eq!(parser.screen().cursor_position(), (2, 4));

    parser.process("\x1b[2;1H界xyz\x1b[2;2H\x1b[4hW".as_bytes());
    assert!(!parser.screen().cell(1, 0).unwrap().has_contents());
    assert_eq!(parser.screen().cell(1, 1).unwrap().contents(), "W");
    assert_eq!(parser.screen().cell(1, 3).unwrap().contents(), "x");
}

#[test]
fn reverse_backspace_stays_inside_the_margin_and_unwraps_the_line() {
    let mut parser = vt100::Parser::new(4, 5, 0);
    parser.process("abcd界\x1b[2;1H\x1b[?45h\x08".as_bytes());
    assert_eq!(parser.screen().cursor_position(), (0, 3));
    assert!(!parser.screen().row_wrapped(0));

    parser.process(b"\x1b[2;3r\x1b[1;1Habcdef\x1b[2;1H\x08");
    assert_eq!(parser.screen().cursor_position(), (1, 0));
    assert!(parser.screen().row_wrapped(0));
}

#[test]
fn snapshot_restores_the_origin_margin_and_pending_wrap() {
    let mut source = vt100::Parser::new(5, 5, 0);
    source
        .process("\x1b[2;4r\x1b[?6h\x1b[2;1H\x1b[31mabc界\x1b[0m".as_bytes());
    assert_eq!(source.screen().cursor_position(), (2, 5));

    let mut restored = vt100::Parser::new(5, 5, 0);
    restored.process(&source.screen().state_formatted());
    assert_eq!(restored.screen().cursor_position(), (2, 5));
    assert_eq!(restored.screen().contents(), source.screen().contents());
    restored.process(b"X\x1b[2;2H\x1b[4hY");
    assert_eq!(restored.screen().cell(2, 1).unwrap().contents(), "Y");
    assert_eq!(restored.screen().cell(2, 3).unwrap().contents(), "c");
    assert_eq!(restored.screen().cell(3, 0).unwrap().contents(), "X");
    assert_eq!(restored.screen().cursor_position(), (2, 2));
}

#[test]
fn soft_reset_clears_snapshot_modes_without_erasing_the_grid() {
    let mut parser = vt100::Parser::new(4, 8, 0);
    parser.process(
        b"\x1b[2;4r\x1b[?6;45;66;1004;2004;2026h\x1b[?7l\x1b[4h\x1b[2;3HZ",
    );
    assert!(parser.screen().synchronized_output());
    let cursor = parser.screen().cursor_position();
    parser.process(b"\x1b[!p");
    let screen = parser.screen();
    assert_eq!(screen.cursor_position(), cursor);
    assert_eq!(screen.cell(2, 2).unwrap().contents(), "Z");
    assert!(!screen.insert_mode());
    assert!(!screen.origin_mode());
    assert!(!screen.reverse_wraparound());
    assert!(!screen.focus_reporting());
    assert!(!screen.application_keypad());
    assert!(!screen.bracketed_paste());
    assert!(!screen.synchronized_output());
    assert!(screen.wraparound());
}
