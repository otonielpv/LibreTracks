//! «Buscar en la red» contra un servidor local: lo que contesta como el
//! programa aparece; lo que contesta otra cosa, o nada, no.

use std::net::{IpAddr, Ipv4Addr};

use libretracks_core::LyricsSoftware;
use libretracks_lyrics::scan::scan;
use libretracks_test_http::{serve, Response};

fn port_of(base: &str) -> u16 {
    base.rsplit(':').next().unwrap().parse().unwrap()
}

const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

#[tokio::test]
async fn finds_freeshow_on_this_computer() {
    let base = serve(|request, _| {
        assert_eq!(request.method, "POST");
        Response::json(200, r#"{"show1":{"name":"Way Maker"}}"#)
    })
    .await;
    let port = port_of(&base);
    let found = scan(LyricsSoftware::FreeShow, vec![LOCAL], vec![port], vec![], None).await;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].host, "127.0.0.1");
    assert_eq!(found[0].port, port);
    assert!(found[0].this_device);
    assert!(!found[0].needs_token);
}

#[tokio::test]
async fn another_web_server_on_the_port_is_not_listed() {
    let base = serve(|_, _| Response::json(200, "<html>router</html>")).await;
    let found = scan(LyricsSoftware::Holyrics, vec![LOCAL], vec![port_of(&base)], vec![], None).await;
    assert!(found.is_empty());
}

#[tokio::test]
async fn propresenter_found_by_an_extra_address_is_identified() {
    let base = serve(|request, _| {
        assert_eq!(request.target, "/version");
        Response::json(200, r#"{"name":"FOH","host_description":"ProPresenter 7.16","api_version":"v1"}"#)
    })
    .await;
    let port = port_of(&base);
    // Nothing to sweep: only the address mDNS would have given.
    let found = scan(LyricsSoftware::ProPresenter, vec![], vec![], vec![(LOCAL, port)], None).await;
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].label, "ProPresenter 7.16");
}
