/**
 * Cómo se muestra a la persona en la caja: su nombre si lo tiene, si no la
 * parte del correo antes de la arroba. Un cajero lee "Camila", no
 * "demo@sistemapos.local". El correo sigue siendo la identidad que se guarda.
 */
export function nombreVisible(user: { name?: string; email: string }): string {
  return user.name?.trim() || user.email.split('@')[0] || user.email;
}
