/**
 * Zod validation middleware factory
 */

const { ValidationError } = require('../utils/errors');

/**
 * Creates middleware that validates req.body against a Zod schema.
 * On success, replaces req.body with the parsed (and coerced) data.
 * On failure, throws a ValidationError with field-level details.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map(issue => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return next(new ValidationError(errors));
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
