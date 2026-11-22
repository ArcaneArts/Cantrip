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

#[test]
fn line_feed_at_top_anchored_region_retains_history_and_scroll_up_does_not() {
    let mut parser = vt100::Parser::new(4, 8, 16);
    parser.process(b"top\x1b[1;2r\x1b[2;1H\x1b[44m\n");
    assert_eq!(
        parser.screen().cell(1, 7).unwrap().bgcolor(),
        vt100::Color::Idx(4)
    );
    parser.process(b"\x1b[r\x1b[41m\x1b[S");
    assert_eq!(
        parser.screen().cell(3, 7).unwrap().bgcolor(),
        vt100::Color::Idx(1)
    );
    let (_, history) = parser
        .screen()
        .normal_contents_formatted_with_scrollback(4096)
        .unwrap();
    assert_eq!(history, 1);
    parser.screen_mut().set_scrollback(1);
    assert_eq!(parser.screen().cell(0, 0).unwrap().contents(), "t");
}

#[test]
fn snapshot_budget_counts_utf16_units_for_scrollback() {
    let mut parser = vt100::Parser::new(3, 18, 20);
    for row in 0..10 {
        parser.process(format!("{row}:界面🙂履歴\r\n").as_bytes());
    }
    let screen = parser.screen();
    let (full, history) = screen
        .normal_contents_formatted_with_scrollback(4096)
        .unwrap();
    assert!(history > 0);
    let budget = std::str::from_utf8(&full).unwrap().encode_utf16().count();
    assert!(budget < full.len());

    let (exact, kept) = screen
        .normal_contents_formatted_with_scrollback(budget)
        .unwrap();
    assert_eq!(kept, history);
    assert_eq!(exact, full);
    let (bounded, kept) = screen
        .normal_contents_formatted_with_scrollback(budget - 1)
        .unwrap();
    assert!(kept < history);
    let used = std::str::from_utf8(&bounded)
        .unwrap()
        .encode_utf16()
        .count();
    assert!(used < budget);
    let mut viewer = vt100::Parser::new(3, 18, 20);
    viewer.process(&bounded);
    assert_eq!(viewer.screen().contents(), screen.contents());
}
