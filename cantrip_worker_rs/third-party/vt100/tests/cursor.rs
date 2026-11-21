#[test]
fn cursor_commands_and_alternate_switches_keep_per_buffer_saves() {
    let mut parser = vt100::Parser::new(5, 16, 4);
    parser.process(b"\x1b[3;5H\x1b[31m\x1b[s\x1b[4;7H\x1b[?1047h");
    assert!(parser.screen().alternate_screen());
    assert_eq!(parser.screen().cursor_position(), (3, 6));

    parser.process(b"\x1b[2;3H\x1b[34m\x1b[?1048h\x1b[H\x1b[?1048lA");
    assert_eq!(parser.screen().cell(1, 2).unwrap().contents(), "A");
    parser.process(b"\x1b[?1047lB\x1b[uN");
    let screen = parser.screen();
    assert!(!screen.alternate_screen());
    assert_eq!(screen.cell(1, 3).unwrap().contents(), "B");
    assert_eq!(screen.cell(2, 4).unwrap().contents(), "N");
    assert_eq!(screen.cell(2, 4).unwrap().fgcolor(), vt100::Color::Idx(1));

    parser.process(b"\x1b[?1047h");
    assert_eq!(parser.screen().contents(), "");
}

#[test]
fn restore_uses_the_live_origin_and_scrollback_boundary() {
    let mut parser = vt100::Parser::new(4, 8, 5);
    parser.process(b"\x1b[4;3H\x1b7\n\n\x1b8");
    assert_eq!(parser.screen().cursor_position(), (1, 2));

    parser.process(b"\x1b[3;4r\x1b[?6h\x1b8");
    assert!(parser.screen().origin_mode());
    assert_eq!(parser.screen().cursor_position(), (2, 2));
}

#[test]
fn restored_cursor_clamps_a_saved_pending_wrap() {
    let mut parser = vt100::Parser::new(2, 3, 0);
    parser.process(b"abc\x1b7\x1b[H\x1b8D");
    assert_eq!(parser.screen().contents(), "abD");
}
