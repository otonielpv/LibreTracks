//! Escribir un fichero de sesión sin poder dejarlo a medias.
//!
//! `fs::write` **primero vacía el fichero y después escribe**, y no espera a
//! que los bytes lleguen al disco. Entre una cosa y otra, lo que había se ha
//! perdido y lo nuevo todavía no está. En un pendrive por OTG eso se vio en el
//! teléfono: se quitó justo después de guardar, Android forzó el desmontaje y
//! `TestOTG.ltsession` quedó en 0 bytes. La sesión entera perdida, no sólo el
//! último cambio. Lo mismo vale para una batería que se acaba o un proceso que
//! el sistema mata.
//!
//! Aquí se escribe en un temporal al lado, se fuerza a disco (`sync_all`) y se
//! renombra encima. Renombrar dentro de la misma carpeta es atómico en los
//! sistemas de ficheros que importan (ext4, F2FS, NTFS, APFS, y exFAT/FAT a
//! través del FUSE de Android): quien lea después ve el fichero viejo entero o
//! el nuevo entero, nunca uno vacío.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Sustituye el contenido de `path` por `bytes`, todo o nada.
///
/// Si algo falla antes de renombrar, el fichero original queda intacto y el
/// temporal se borra.
pub fn write_file_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = temp_path_for(path);
    let result = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        // Sin esto, el rename puede llegar al disco ANTES que los datos, y el
        // resultado tras un corte sería el mismo fichero vacío de antes.
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// `<nombre>.tmp` en la misma carpeta. Tiene que ser la misma: un rename entre
/// carpetas de volúmenes distintos no es atómico, ni siquiera es un rename.
fn temp_path_for(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_content_and_leaves_no_temp_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Concierto.ltsession");
        fs::write(&path, "viejo").unwrap();

        write_file_atomically(&path, b"nuevo").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "nuevo");
        assert!(!temp_path_for(&path).exists());
    }

    /// El caso del pendrive, reducido: si la escritura no llega a completarse,
    /// lo que habia tiene que seguir ahi. Aqui falla el rename (el destino es
    /// una carpeta), que es el ultimo paso: el original no se ha tocado.
    #[test]
    fn a_failed_write_keeps_the_previous_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Concierto.ltsession");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("dentro"), "intacto").unwrap();

        assert!(write_file_atomically(&path, b"nuevo").is_err());

        assert_eq!(fs::read_to_string(path.join("dentro")).unwrap(), "intacto");
        assert!(!temp_path_for(&path).exists());
    }
}
