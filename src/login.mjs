import express from 'express';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import config from './config.mjs';

export const authRouter = express.Router();

passport.use(
  new LocalStrategy(function(username, password, cb) {
    if (username === config.USER_LOGIN && password === config.USER_PASSWORD) {
      return cb(null, { user: 'bull-board' });
    }

    return cb(null, false);
  }),
);

passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});

authRouter
  .route('/')
  .get((req, res) => {
    res.render('login');
  })
  .post(
    passport.authenticate('local', {
      successRedirect: config.PROXY_HOME_PAGE,
      failureRedirect: config.PROXY_LOGIN_PAGE,
    }),
  );
