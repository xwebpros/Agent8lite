/** Static React rendering tests use Vite's CSS module loader without the Next application compiler. */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
