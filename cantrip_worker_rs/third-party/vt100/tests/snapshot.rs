#[test]
fn scrollback_and_viewport_share_the_same_soft_wrap() {
    let mut source = vt100::Parser::new(3, 5, 16);
    source.process(b"\x1b[31mabcdefghijk\x1b[m\r\none\r\ntwo");
    let (bytes, history_rows) = source
        .screen()
        .normal_contents_formatted_with_scrollback(1024)
        .unwrap();
    let mut restored = vt100::Parser::new(3, 5, 16);
    restored.process(b"old\r\nold\r\nold\r\nold\r\n");
    restored.process(&bytes);
    assert_eq!(restored.screen().contents(), "k\none\ntwo");
    assert_eq!(restored.screen().cursor_position(), (2, 3));
    restored.screen_mut().set_scrollback(16);
    assert_eq!(history_rows, 2);
    assert_eq!(restored.screen().scrollback(), history_rows);
    assert_eq!(restored.screen().contents(), "abcdefghijk");
    assert!(restored.screen().row_wrapped(0));
    assert!(restored.screen().row_wrapped(1));
    assert_eq!(
        restored.screen().cell(0, 0).unwrap().fgcolor(),
        vt100::Color::Idx(1)
    );
}

#[test]
fn dropping_history_to_fit_does_not_cut_the_viewport() {
    let mut source = vt100::Parser::new(3, 5, 16);
    source.process(b"old1\r\nold2\r\nold3\r\none\r\ntwo\r\nthree");
    let (full, full_rows) = source
        .screen()
        .normal_contents_formatted_with_scrollback(1024)
        .unwrap();
    let (bounded, bounded_rows) = source
        .screen()
        .normal_contents_formatted_with_scrollback(full.len() - 1)
        .unwrap();
    assert!(bounded.len() < full.len());
    let mut restored = vt100::Parser::new(3, 5, 16);
    restored.process(&bounded);
    assert_eq!(restored.screen().contents(), "one\ntwo\nthree");
    restored.screen_mut().set_scrollback(16);
    assert!(bounded_rows < full_rows);
    assert_eq!(restored.screen().scrollback(), bounded_rows);
}

#[test]
fn snapshot_restores_default_tabs_over_an_earlier_attachment() {
    let source = vt100::Parser::new(3, 16, 0);
    let (bytes, _) = source
        .screen()
        .normal_contents_formatted_with_scrollback(1024)
        .unwrap();
    let mut restored = vt100::Parser::new(3, 16, 0);
    restored.process(b"\x1b[3g\x1b[5G\x1bH");
    restored.process(&bytes);
    restored.process(b"\tX");
    assert_eq!(restored.screen().cell(0, 8).unwrap().contents(), "X");
    assert_eq!(restored.screen().cursor_position(), (0, 9));
}
