#[test]
fn designated_sets_map_text_as_shifts_arrive() {
    let mut parser = vt100::Parser::new(5, 24, 0);
    parser.process(b"\x1b(0lqk\x1b(B\r\n\x1b)");
    parser.process(b"0\x0elqk\x0f\r\n\x1b*A\x1bn#\x0f\r\n");
    parser.process("\x1b+K\x1bo[\\] 界\x0f\r\n\x1b(4[".as_bytes());
    assert_eq!(parser.screen().contents(), "┌─┐\n┌─┐\n£\nÄÖÜ 界\ni");
}

#[test]
fn cursor_save_and_soft_reset_update_the_active_map() {
    let mut parser = vt100::Parser::new(3, 12, 0);
    parser.process(b"\x1b)0\x0e\x1b7\x0f\x1b8x\x1b[!px\x0ex");
    assert_eq!(parser.screen().contents(), "│xx");
    parser.process(b"\x0f\x1b(0q\x1b%Gq");
    assert_eq!(parser.screen().contents(), "│xx─q");
}

#[test]
fn formatted_character_sets_restore_the_next_print_and_later_shift() {
    let mut source = vt100::Parser::new(3, 12, 4);
    source.process(b"\x1b*A\x1b)0\x0elqk");
    let snapshot = source.screen().contents_formatted();
    let mut restored = vt100::Parser::new(3, 12, 4);
    restored.process(&snapshot);
    restored.process(&source.screen().character_sets_formatted());
    restored.process(b"\r\nx\x1bn#\x0f(x)");
    assert_eq!(restored.screen().contents(), "┌─┐\n│£(x)");
}
