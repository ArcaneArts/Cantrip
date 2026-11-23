const PAINT: &str = "x\x1b[1\"q界KEEP\x1b[0\"qy\r\nz\x1b[1\"qSTAY\x1b[0\"qw";

#[test]
fn selective_erase_keeps_protected_cells_in_each_range() {
    for (operation, expected) in [
        ("\x1b[1;3H\x1b[?0K", "x界KEEP\nzSTAYw"),
        ("\x1b[1;3H\x1b[?1K", " 界KEEPy\nzSTAYw"),
        ("\x1b[1;3H\x1b[?2K", " 界KEEP\nzSTAYw"),
        ("\x1b[1;3H\x1b[?0J", "x界KEEP\n STAY"),
        ("\x1b[2;2H\x1b[?1J", " 界KEEP\n STAYw"),
        ("\x1b[?2J", " 界KEEP\n STAY"),
        ("\x1b[2J", ""),
    ] {
        let mut parser = vt100::Parser::new(3, 18, 0);
        parser.process(PAINT.as_bytes());
        parser.process(operation.as_bytes());
        assert_eq!(parser.screen().contents(), expected, "{operation:?}");
    }
}

#[test]
fn canonical_replay_retains_protection_across_later_erases() {
    let mut original = vt100::Parser::new(3, 18, 0);
    original.process(PAINT.as_bytes());
    original.process(b"\x1b[1\"q");
    let (snapshot, _) = original
        .screen()
        .normal_contents_formatted_with_scrollback(16_000)
        .unwrap();
    let mut restored = vt100::Parser::new(3, 18, 0);
    restored.process(&snapshot);
    let live = b"+\x1b[0m-\x1b[?2J";
    original.process(live);
    restored.process(live);
    assert_eq!(original.screen().contents(), " 界KEEP\n STAY +");
    assert_eq!(restored.screen().contents(), original.screen().contents());
}
