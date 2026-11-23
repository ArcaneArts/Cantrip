#[test]
fn unicode_columns_match_the_cantrip_xterm_viewer() {
    for (text, width) in [
        ("🙂", 1),
        ("🚀", 1),
        ("界", 2),
        ("𰻞", 2),
        ("🧑‍🔧", 2),
        ("❤️", 1),
        ("e\u{301}", 1),
    ] {
        let mut parser = vt100::Parser::new(3, 12, 0);
        parser.process(format!("{text}Z").as_bytes());
        assert_eq!(
            parser.screen().cursor_position(),
            (0, width + 1),
            "{text}"
        );
        assert_eq!(parser.screen().cell(0, width).unwrap().contents(), "Z");
        assert_eq!(parser.screen().contents(), format!("{text}Z"));
    }
}

#[test]
fn replay_keeps_emoji_at_the_margin_and_preserves_the_next_cursor_move() {
    let mut source = vt100::Parser::new(3, 8, 0);
    source.process("1234567🙂!".as_bytes());
    assert_eq!(source.screen().contents(), "1234567🙂!");
    assert_eq!(source.screen().cursor_position(), (1, 1));
    let (snapshot, _) = source
        .screen()
        .normal_contents_formatted_with_scrollback(16_000)
        .unwrap();

    let mut viewer = vt100::Parser::new(3, 8, 0);
    viewer.process(&snapshot);
    assert_eq!(viewer.screen().contents(), source.screen().contents());
    let edit = b"\x1b[1;8HX";
    source.process(edit);
    viewer.process(edit);
    assert_eq!(source.screen().contents(), "1234567X!");
    assert_eq!(viewer.screen().contents(), source.screen().contents());
}
