#[test]
fn repeated_graphics_survive_terminal_replay_and_wrapping() {
    let mut source = vt100::Parser::new(4, 8, 4);
    source.process("A\x1b[0b界\x1b[".as_bytes());
    source.process(b"3b");

    let mut replay = vt100::Parser::new(4, 8, 4);
    let (snapshot, _) = source
        .screen()
        .normal_contents_formatted_with_scrollback(4096)
        .unwrap();
    replay.process(&snapshot);
    assert_eq!(replay.screen().contents(), "AA界界界界");
    assert_eq!(replay.screen().cursor_position(), (1, 2));
    assert!(replay.screen().row_wrapped(0));
    assert_eq!(replay.screen().cell(1, 0).unwrap().contents(), "界");
}

#[test]
fn repeat_preserves_combining_marks_style_and_translated_characters() {
    let mut source = vt100::Parser::new(4, 8, 4);
    source.process("\x1b[31me\u{0301}\x1b[2b\r\n\x1b(0q\x1b[3b".as_bytes());

    let mut replay = vt100::Parser::new(4, 8, 4);
    replay.process(&source.screen().contents_formatted());
    assert_eq!(
        replay.screen().contents(),
        "e\u{0301}e\u{0301}e\u{0301}\n────"
    );
    for col in 0..3 {
        let cell = replay.screen().cell(0, col).unwrap();
        assert_eq!(cell.fgcolor(), vt100::Color::Idx(1));
    }
}

#[test]
fn repeat_clears_the_preceding_graphic_after_control_functions() {
    for control in [
        &b"\x1b[31m"[..],
        b"\x07",
        b"\x1b]2;title\x07",
        b"\x1bPqtest\x1b\\",
        b"\x1b(B",
    ] {
        let mut source = vt100::Parser::new(4, 8, 4);
        source.process(b"X");
        source.process(control);
        source.process(b"\x1b[3b!");
        assert_eq!(source.screen().contents(), "X!", "{control:?}");
    }
    let mut source = vt100::Parser::new(4, 8, 4);
    source.process(b"X\x1b[2b\x1b[2b!");
    assert_eq!(source.screen().contents(), "XXX!");
}

#[test]
fn repeat_uses_the_preceding_width_at_the_right_edge_without_wrap() {
    let mut source = vt100::Parser::new(4, 8, 4);
    source.process("\x1b[?7lABCDEFGH界\x1b[2b".as_bytes());
    assert_eq!(source.screen().contents(), "ABCDEFGF");
    assert_eq!(source.screen().cursor_position(), (0, 8));
}
