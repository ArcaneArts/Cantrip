//! Prepare matching helper resources before embedding, including cross builds.
//! Extracted fallback tools then need no resource editing at server startup.
use std::{env, error::Error, fs, path::Path};

use xmltree::{Element, XMLNode};

const APPLICATION: &str = "urn:schemas-microsoft-com:asm.v3";
const SETTINGS: &str = "http://schemas.microsoft.com/SMI/2019/WindowsSettings";

fn child<'a>(parent: &'a mut Element, name: &str, namespace: &str) -> &'a mut Element {
    let index = parent.children.iter().position(|node| {
        matches!(node, XMLNode::Element(element) if element.name == name && element.namespace.as_deref() == Some(namespace))
    });
    let index = index.unwrap_or_else(|| {
        let mut element = Element::new(name);
        element.namespace = Some(namespace.into());
        element.namespaces = Some(xmltree::Namespace::empty());
        element.namespaces.as_mut().unwrap().put("", namespace);
        parent.children.push(XMLNode::Element(element));
        parent.children.len() - 1
    });
    parent.children[index].as_mut_element().unwrap()
}

fn utf8_manifest(bytes: &[u8]) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut document = Element::parse(bytes)?;
    let settings = child(
        child(&mut document, "application", APPLICATION),
        "windowsSettings",
        APPLICATION,
    );
    let code_page = child(settings, "activeCodePage", SETTINGS);
    code_page.children = vec![XMLNode::Text("UTF-8".into())];
    let mut xml = Vec::new();
    document.write(&mut xml)?;
    Ok(xml)
}

fn enable_utf8(path: &Path) -> Result<(), Box<dyn Error>> {
    use editpe::{ResourceEntry, ResourceEntryName::ID};
    let mut image = editpe::Image::parse_file(path)?;
    let mut resources = image.resource_directory().cloned().unwrap_or_default();
    let languages = match resources.root_mut().get_mut(ID(24)) {
        Some(ResourceEntry::Table(manifests)) => match manifests.get_mut(ID(1)) {
            Some(ResourceEntry::Table(languages)) => Some(languages),
            None => None,
            Some(_) => return Err("executable manifest must be a language table".into()),
        },
        None => None,
        Some(_) => return Err("manifest resources must be a table".into()),
    };
    let mut updated = false;
    if let Some(languages) = languages {
        // set_manifest updates en-US only. Windows may select the original
        // neutral or another language instead, so preserve and update each.
        let names: Vec<_> = languages.entries().into_iter().cloned().collect();
        for name in names {
            let Some(ResourceEntry::Data(data)) = languages.get_mut(name) else {
                return Err("executable manifest language must contain XML data".into());
            };
            data.set_data(utf8_manifest(data.data())?);
            data.set_codepage(65001);
            updated = true;
        }
    }
    if !updated {
        let xml = utf8_manifest(
            b"<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\"/>",
        )?;
        resources.set_manifest(std::str::from_utf8(&xml)?)?;
    }
    image.set_resource_directory(resources)?;
    image.write_file(path)?;
    Ok(())
}

fn visit(directory: &Path) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            visit(&path)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            enable_utf8(&path)?;
        }
    }
    Ok(())
}

pub fn prepare(archive: &Path) -> Result<(), Box<dyn Error>> {
    if env::var("CARGO_CFG_TARGET_OS")?.as_str() != "windows" {
        return Ok(());
    }
    let directory = archive.parent().unwrap().join("runtime-utf8");
    if directory.exists() {
        fs::remove_dir_all(&directory)?;
    }
    fs::create_dir(&directory)?;
    tar::Archive::new(fs::File::open(archive)?).unpack(&directory)?;
    visit(&directory)?;
    let mut builder = tar::Builder::new(fs::File::create(archive)?);
    builder.append_dir_all(".", &directory)?;
    builder.finish()?;
    fs::remove_dir_all(directory)?;
    Ok(())
}
