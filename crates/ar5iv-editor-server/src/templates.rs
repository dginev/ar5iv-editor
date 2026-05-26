use askama::Template;

#[derive(Template)]
#[template(path = "editor.html")]
pub struct EditorTemplate;

#[derive(Template)]
#[template(path = "vscode.html")]
pub struct VscodeTemplate;

#[derive(Template)]
#[template(path = "about.html")]
pub struct AboutTemplate;

#[derive(Template)]
#[template(path = "help.html")]
pub struct HelpTemplate;

#[derive(Template)]
#[template(path = "schemas.html")]
pub struct SchemasTemplate;
